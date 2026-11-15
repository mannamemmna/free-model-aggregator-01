import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderHealth } from '../lib/health.ts';
import { toGemini } from '../lib/bridge.ts';

test('temporary refusals become retryable and success clears their history', () => {
  const health = new ProviderHealth();
  assert.equal(health.cooling('a', 1), false);
  health.refused('a', 1);
  assert.equal(health.cooling('a', 2), true);
  assert.equal(health.cooling('b', 2), false);
  assert.equal(health.cooling('a', 3), false);
  health.refused('a', 3);
  assert.equal(health.cooling('a', 6), true);
  assert.equal(health.cooling('a', 7), false);
  health.recovered('a');
  assert.equal(health.cooling('a', 4), false);
  health.refused('a', 8);
  assert.equal(health.cooling('a', 10), false);
});

test('persistent refusals never permanently eliminate a provider', () => {
  const health = new ProviderHealth();
  for (let request = 1; request <= 200; request++) health.refused('a', request);
  assert.equal(health.cooling('a', 263), true);
  assert.equal(health.cooling('a', 264), false);
});

test('Gemini JSON schema requests preserve JSON mode, schema and output limit', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  const out = toGemini({ messages: [{ role: 'user', content: 'Return status' }], response_format: { type: 'json_schema', json_schema: { schema } }, max_tokens: 73 });
  assert.deepEqual(out.generationConfig, { maxOutputTokens: 73, responseMimeType: 'application/json', responseJsonSchema: schema });
});
