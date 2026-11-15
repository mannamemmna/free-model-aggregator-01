import { isRecord, type Json } from './providers.ts';
import { openAIToAnthropic, sseEvent } from './wire.ts';

const rows = (v: unknown): Json[] => Array.isArray(v) ? v.filter(isRecord) : [];
const text = (v: unknown): string => typeof v === 'string' ? v : rows(v).filter(b => b.type === 'text').map(b => b.text).join('\n');
const args = (v: unknown): Json => { if (isRecord(v)) return v; try { const a = JSON.parse(String(v)); return isRecord(a) ? a : {}; } catch { return {}; } };

export function toAnthropic(body: Json, model: string): Json {
  const system: string[] = [];
  const messages: Json[] = [];
  for (const m of rows(body.messages)) {
    if (m.role === 'system' || m.role === 'developer') { system.push(text(m.content)); continue; }
    if (m.role === 'tool') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] });
      continue;
    }
    const blocks: Json[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : rows(m.content).flatMap(b => {
      if (b.type === 'text') return [b];
      if (b.type === 'image_url' && isRecord(b.image_url) && typeof b.image_url.url === 'string') {
        const match = /^data:([^;]+);base64,(.*)$/s.exec(b.image_url.url);
        return [{ type: 'image', source: match ? { type: 'base64', media_type: match[1], data: match[2] } : { type: 'url', url: b.image_url.url } }];
      }
      return [];
    });
    for (const call of rows(m.tool_calls)) if (isRecord(call.function)) blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: args(call.function.arguments) });
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: blocks });
  }
  const out: Json = { model, messages, max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 1024, stream: false };
  if (system.length) out.system = system.join('\n');
  for (const k of ['temperature', 'top_p', 'top_k']) if (body[k] !== undefined) out[k] = body[k];
  if (body.stop !== undefined) out.stop_sequences = typeof body.stop === 'string' ? [body.stop] : body.stop;
  if (Array.isArray(body.tools)) out.tools = rows(body.tools).filter(t => isRecord(t.function)).map(t => ({ name: (t.function as Json).name, description: (t.function as Json).description, input_schema: (t.function as Json).parameters }));
  if (body.tool_choice === 'auto' || body.tool_choice === 'none') out.tool_choice = { type: body.tool_choice };
  else if (body.tool_choice === 'required') out.tool_choice = { type: 'any' };
  else if (isRecord(body.tool_choice) && isRecord(body.tool_choice.function)) out.tool_choice = { type: 'tool', name: body.tool_choice.function.name };
  return out;
}

export function toGemini(body: Json): Json {
  const contents: Json[] = [];
  const system: string[] = [];
  const names = new Map<string, string>();
  for (const m of rows(body.messages)) {
    if (m.role === 'system' || m.role === 'developer') { system.push(text(m.content)); continue; }
    const parts: Json[] = [];
    if (m.role === 'tool') parts.push({ functionResponse: { id: m.tool_call_id, name: names.get(String(m.tool_call_id)) ?? m.name ?? 'tool', response: { result: m.content } } });
    else if (typeof m.content === 'string') parts.push({ text: m.content });
    else for (const b of rows(m.content)) {
      if (b.type === 'text') parts.push({ text: b.text });
      if (b.type === 'image_url' && isRecord(b.image_url) && typeof b.image_url.url === 'string') {
        const match = /^data:([^;]+);base64,(.*)$/s.exec(b.image_url.url);
        parts.push(match ? { inlineData: { mimeType: match[1], data: match[2] } } : { fileData: { fileUri: b.image_url.url } });
      }
    }
    for (const c of rows(m.tool_calls)) if (isRecord(c.function)) { names.set(String(c.id), String(c.function.name)); parts.push({ functionCall: { id: c.id, name: c.function.name, args: args(c.function.arguments) } }); }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  const config: Json = {};
  if (body.max_tokens !== undefined || body.max_completion_tokens !== undefined) config.maxOutputTokens = body.max_tokens ?? body.max_completion_tokens;
  if (body.temperature !== undefined) config.temperature = body.temperature;
  if (body.top_p !== undefined) config.topP = body.top_p;
  if (body.stop !== undefined) config.stopSequences = typeof body.stop === 'string' ? [body.stop] : body.stop;
  if (isRecord(body.response_format) && body.response_format.type !== 'text') {
    config.responseMimeType = 'application/json';
    if (isRecord(body.response_format.json_schema)) config.responseJsonSchema = body.response_format.json_schema.schema;
  }
  const out: Json = { contents, generationConfig: config };
  if (system.length) out.systemInstruction = { parts: [{ text: system.join('\n') }] };
  if (Array.isArray(body.tools)) out.tools = [{ functionDeclarations: rows(body.tools).filter(t => isRecord(t.function)).map(t => t.function) }];
  const choice = body.tool_choice;
  if (choice !== undefined) {
    const fn = isRecord(choice) && isRecord(choice.function) ? choice.function.name : null;
    out.toolConfig = { functionCallingConfig: { mode: choice === 'none' ? 'NONE' : choice === 'required' || fn ? 'ANY' : 'AUTO', ...(fn ? { allowedFunctionNames: [fn] } : {}) } };
  }
  return out;
}

export function fromAnthropic(body: Json): Json {
  const blocks = rows(body.content);
  const calls = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const usage = isRecord(body.usage) ? body.usage : {};
  return { id: body.id, object: 'chat.completion', created: 0, model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text(blocks), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: body.stop_reason === 'max_tokens' ? 'length' : body.stop_reason === 'tool_use' ? 'tool_calls' : body.stop_reason === 'refusal' ? 'content_filter' : 'stop' }],
    usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0) },
    ...(body.stop_sequence ? { stop_sequence: body.stop_sequence } : {}) };
}

export function fromGemini(body: Json, model: string): Json {
  const candidate = rows(body.candidates)[0];
  if (!candidate || !isRecord(candidate.content)) throw new Error('Gemini returned no candidate content');
  const parts = rows(candidate.content.parts);
  const calls = parts.filter(p => isRecord(p.functionCall)).map((p, i) => { const f = p.functionCall as Json; return { id: f.id ?? `call_${i}`, type: 'function', function: { name: f.name, arguments: JSON.stringify(f.args ?? {}) } }; });
  const usage = isRecord(body.usageMetadata) ? body.usageMetadata : {};
  return { id: body.responseId ?? 'gemini_completion', object: 'chat.completion', created: 0, model,
    choices: [{ index: 0, message: { role: 'assistant', content: parts.filter(p => typeof p.text === 'string').map(p => p.text).join(''), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: candidate.finishReason === 'MAX_TOKENS' ? 'length' : ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(String(candidate.finishReason)) ? 'content_filter' : calls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: usage.promptTokenCount, completion_tokens: usage.candidatesTokenCount, total_tokens: usage.totalTokenCount } };
}

export function clientAnswer(answer: Json, api: 'openai' | 'anthropic', model: string): Json {
  if (api === 'openai') return { ...answer, model };
  const result = openAIToAnthropic(answer, model);
  if (answer.stop_sequence) { result.stop_reason = 'stop_sequence'; result.stop_sequence = answer.stop_sequence; }
  return result;
}

export function* clientEvents(answer: Json, api: 'openai' | 'anthropic'): Generator<string> {
  if (api === 'openai') {
    const choice = rows(answer.choices)[0];
    const message = isRecord(choice?.message) ? choice.message : {};
    const base = { id: answer.id, object: 'chat.completion.chunk', created: answer.created ?? 0, model: answer.model };
    const chunk = (delta: Json, finish_reason: unknown = null) => sseEvent(null, { ...base, choices: [{ index: 0, delta, finish_reason }] });
    yield chunk({ role: 'assistant', content: '' });
    if (typeof message.content === 'string' && message.content) yield chunk({ content: message.content });
    for (const [index, call] of rows(message.tool_calls).entries()) yield chunk({ tool_calls: [{ ...call, index }] });
    yield chunk({}, choice.finish_reason);
    yield sseEvent(null, { ...base, choices: [], usage: answer.usage });
    yield 'data: [DONE]\n\n';
    return;
  }
  const usage = isRecord(answer.usage) ? answer.usage : {};
  yield sseEvent('message_start', { type: 'message_start', message: { ...answer, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } });
  for (const [index, block] of rows(answer.content).entries()) {
    const tool = block.type === 'tool_use';
    yield sseEvent('content_block_start', { type: 'content_block_start', index, content_block: tool ? { ...block, input: {} } : { ...block, text: '' } });
    yield sseEvent('content_block_delta', { type: 'content_block_delta', index, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } : { type: 'text_delta', text: block.text ?? '' } });
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index });
  }
  yield sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: answer.stop_reason, stop_sequence: answer.stop_sequence }, usage: { output_tokens: usage.output_tokens } });
  yield sseEvent('message_stop', { type: 'message_stop' });
}
