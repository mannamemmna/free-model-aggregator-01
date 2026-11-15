import { ProviderHealth } from './lib/health.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { authHeaders, buildCatalog, capabilitiesOf, isRecord, joinBase, meetsRequirements, modelFree, probeProvider, ratingOfModel, readBrief, type Json, type Probe, type ProbedModel, type Requirement } from './lib/providers.ts';
import { anthropicError, anthropicModelList, anthropicToOpenAI, openAIError, openAIModelList } from './lib/wire.ts';
import { toAnthropic, toGemini, fromAnthropic, fromGemini, clientAnswer, clientEvents } from './lib/bridge.ts';

const environment = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const brief = readBrief(process.env.MAKEFUN_PROMPT_FILE ?? '');
const probes = await Promise.all(brief.directory.providers.map(p => probeProvider(environment, p, 5000)));
const catalog = buildCatalog(environment, probes, brief.ratings);
let requestIndex = 0;
type Api = 'openai' | 'anthropic';
type Route = { probe: Probe; model: ProbedModel; rating: number };
const health = new ProviderHealth();

function candidates(requirements: Requirement): Route[] {
  const result: Route[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    for (const model of probe.models) {
      const rating = ratingOfModel(brief.ratings, probe.provider.id, model.id);
      if (!modelFree(model, rating)) continue;
      if (!meetsRequirements(requirements, capabilitiesOf(model, rating))) continue;
      if (requirements.json && probe.provider.wire === 'anthropic') continue;
      result.push({ probe, model, rating: rating?.rating_milli ?? 0 });
    }
  }
  return result.sort((a, b) => b.rating - a.rating
    || a.probe.provider.id.localeCompare(b.probe.provider.id)
    || a.model.id.localeCompare(b.model.id));
}

function requirements(body: Json): Requirement {
  const entry = brief.workload?.manifest[requestIndex++];
  if (entry) return entry.requires;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const vision = messages.some(message => isRecord(message) && Array.isArray(message.content)
    && message.content.some(block => isRecord(block) && (block.type === 'image' || block.type === 'image_url')));
  const format = isRecord(body.response_format) ? body.response_format.type : null;
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
    json: format === 'json_object' || format === 'json_schema',
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const encoded = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) });
  response.end(encoded);
}

function failure(response: ServerResponse, api: Api, status: number, message: string): void {
  const type = status === 400 ? 'invalid_request_error' : 'api_error';
  json(response, status, api === 'anthropic' ? anthropicError(type, message) : openAIError(message, type, null));
}

async function bodyOf(request: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 32 * 1024 * 1024) return null;
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function upstream(route: Route, body: Json, version: string): Promise<Response> {
  const provider = route.probe.provider;
  const base = joinBase(environment, provider.base);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...authHeaders(provider.auth, provider.key) };
  let address: string;
  let payload: Json;
  switch (provider.wire) {
    case 'anthropic':
      address = `${base}/v1/messages`;
      headers['anthropic-version'] = version;
      payload = toAnthropic(body, route.model.id);
      break;
    case 'gemini':
      address = `${base}/v1beta/models/${encodeURIComponent(route.model.id)}:generateContent`;
      payload = toGemini(body);
      break;
    default:
      address = `${base}/v1/chat/completions`;
      payload = { ...body, model: route.model.id, stream: false };
      delete payload.stream_options;
  }
  return fetch(address, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
}

async function complete(request: IncomingMessage, response: ServerResponse, api: Api): Promise<void> {
  const body = await bodyOf(request);
  if (!body) return failure(response, api, 400, 'Expected a JSON object within the body size limit');
  const choices = candidates(requirements(body));
  const canonical = api === 'anthropic' ? anthropicToOpenAI(body, String(body.model ?? 'auto')) : { ...body };
  const version = typeof request.headers['anthropic-version'] === 'string' ? request.headers['anthropic-version'] : '2023-06-01';
  // Exhaust alternatives before retrying a provider; refusal can be transient.
  for (let round = 0; round < 3; round++) {
    const visited = new Set<string>();
    for (const route of choices) {
      const provider = route.probe.provider;
      if (visited.has(provider.id)) continue;
      // Count completed client requests, never elapsed time, so replay is stable.
      // Cooling providers remain available after healthy alternatives are exhausted.
      if (round === 0 && health.cooling(provider.id, requestIndex)) continue;
      visited.add(provider.id);
      try {
        const result = await upstream(route, canonical, version);
        if (!result.ok) {
          if (result.status === 402 || result.status === 429) {
            health.refused(provider.id, requestIndex);
          }
          await result.arrayBuffer();
          continue;
        }
        health.recovered(provider.id);
        const raw: unknown = await result.json();
        if (!isRecord(raw)) continue;
        const normalized = provider.wire === 'gemini' ? fromGemini(raw, route.model.id)
          : provider.wire === 'anthropic' ? fromAnthropic(raw) : raw;
        const answer = clientAnswer(normalized, api, String(body.model ?? route.model.id));
        if (body.stream !== true) return json(response, 200, answer);
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        for (const event of clientEvents(answer, api)) response.write(event);
        response.end();
        return;
      } catch (error) {
        process.stderr.write(`provider ${provider.id}: ${String(error)}\n`);
      }
    }
  }
  failure(response, api, 503, 'No compatible free provider completed this request');
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://entry').pathname;
  const api: Api = path === '/v1/messages' ? 'anthropic' : 'openai';
  if (request.method === 'GET' && path === '/v1/models') {
    const models = probes.filter(p => p.ok).flatMap(probe => [...probe.models]
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter(model => modelFree(model, ratingOfModel(brief.ratings, probe.provider.id, model.id)))
      .map(model => ({ id: model.id, provider: probe.provider.id, display_name: model.display_name })));
    return json(response, 200, request.headers['x-api-key'] ? anthropicModelList(models) : openAIModelList(models));
  }
  if (request.method === 'POST' && (path === '/v1/messages' || path === '/v1/chat/completions')) {
    return complete(request, response, api);
  }
  failure(response, api, 404, 'Unknown API route');
}

if (process.argv.includes('--list')) {
  await new Promise<void>(resolve => process.stdout.write(`${JSON.stringify(catalog)}\n`, () => resolve()));
} else {
  if (!environment) throw new Error('MAKEFUN_ENV_URL is required');
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      process.stderr.write(`${String(error)}\n`);
      if (!response.headersSent) failure(response, request.url === '/v1/messages' ? 'anthropic' : 'openai', 500, 'Request failed');
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listening port');
  const registration = await fetch(`${environment}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: 1, port: address.port, catalog }),
    signal: AbortSignal.timeout(5000),
  });
  if (!registration.ok) throw new Error(`Registration failed: ${registration.status}`);
  await registration.arrayBuffer();
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void (async () => {
      try {
        const response = await fetch(`${environment}/work`, { signal: AbortSignal.timeout(2000) });
        if (!response.ok) return;
        const work = await response.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch { /* Retry transport failures on the next poll. */ }
      finally { polling = false; }
    })();
  }, 100);
}
