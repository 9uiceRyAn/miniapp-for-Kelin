const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db');
const models = require('../src/learning/models');

test('normalizeBaseURL normalizes OpenAI v1 chat URLs and rejects invalid values', () => {
  assert.equal(models.normalizeBaseURL('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(
    models.normalizeBaseURL('  https://api.example.com/v1/chat/completions  '),
    'https://api.example.com/v1',
  );
  assert.equal(
    models.normalizeBaseURL('https://api.example.com/v1/models/'),
    'https://api.example.com/v1',
  );
  assert.throws(() => models.normalizeBaseURL(''), /API 网址/);
  assert.throws(() => models.normalizeBaseURL('ftp://api.example.com/v1'), /API 网址/);
  assert.throws(() => models.normalizeBaseURL('not-a-url'), /API 网址/);
  assert.throws(() => models.normalizeBaseURL('https://example.com/v1?key=value'), /API 网址/);
});

test('toLitellmModel ensures openai/ prefix for OpenAI v1 compatible models', () => {
  assert.equal(models.toLitellmModel('gpt-4o'), 'openai/gpt-4o');
  assert.equal(models.toLitellmModel('deepseek-ai/DeepSeek-V3'), 'openai/deepseek-ai/DeepSeek-V3');
  assert.equal(models.toLitellmModel('openai/test'), 'openai/test');
});

test('models.create preserves native provider defaults and normalizes custom OpenAI endpoints', async (t) => {
  const prevBase = process.env.LITELLM_BASE_URL;
  const prevKey = process.env.LITELLM_MODEL_ADMIN_KEY;
  process.env.LITELLM_BASE_URL = 'http://127.0.0.1:4000';
  process.env.LITELLM_MODEL_ADMIN_KEY = 'admin-key';
  t.after(() => {
    if (prevBase !== undefined) process.env.LITELLM_BASE_URL = prevBase;
    else delete process.env.LITELLM_BASE_URL;
    if (prevKey !== undefined) process.env.LITELLM_MODEL_ADMIN_KEY = prevKey;
    else delete process.env.LITELLM_MODEL_ADMIN_KEY;
  });

  await assert.rejects(
    models.create({ name: 'Demo', upstreamModel: 'x'.repeat(192), apiKey: 'sk-test' }),
    /191/,
  );

  let gatewayPayload = null;
  let insertedRow = null;
  t.mock.method(global, 'fetch', async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:4000/model/new');
    gatewayPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({ model_info: { id: 'remote-1' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  t.mock.method(pool, 'execute', async (sql, params) => {
    if (sql.startsWith('INSERT INTO kl_models')) {
      insertedRow = params;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT * FROM kl_models WHERE id=?')) {
      return [[{
        id: insertedRow[0],
        name: insertedRow[1],
        gateway_id: insertedRow[2],
        upstream_model: insertedRow[3],
        credential_ref: insertedRow[4],
        enabled: 1,
        capabilities: insertedRow[5],
        parameters: insertedRow[6],
      }]];
    }
    return [[]];
  });

  const created = await models.create({
    name: 'My GPT',
    baseURL: 'https://relay.example.com/v1/chat/completions',
    upstreamModel: 'gpt-4o-mini',
    apiKey: 'sk-secret',
  });

  assert.equal(gatewayPayload.litellm_params.model, 'openai/gpt-4o-mini');
  assert.equal(gatewayPayload.litellm_params.api_base, 'https://relay.example.com/v1');
  assert.equal(gatewayPayload.litellm_params.api_key, 'sk-secret');
  assert.equal(created.upstream_model, 'gpt-4o-mini');
  await models.create({ name: 'Legacy', upstreamModel: 'anthropic/test', apiKey: 'sk-test' });
  assert.equal(gatewayPayload.litellm_params.model, 'anthropic/test');
  assert.equal(gatewayPayload.litellm_params.api_base, undefined);
});

test('models.discover fetches, falls back to /v1/models on 404, deduplicates and sorts models', async (t) => {
  const seen = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization || null });
    if (url === 'https://relay.example.com/models') {
      return new Response('{}', { status: 404 });
    }
    if (url === 'https://relay.example.com/v1/models') {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'gpt-4o' },
            { id: 'deepseek-chat' },
            { id: 'gpt-4o' },
            { id: '' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 500 });
  });

  const result = await models.discover({
    baseURL: 'https://relay.example.com',
    apiKey: 'sk-discover-key',
  });

  assert.deepEqual(seen, [
    { url: 'https://relay.example.com/models', auth: 'Bearer sk-discover-key' },
    { url: 'https://relay.example.com/v1/models', auth: 'Bearer sk-discover-key' },
  ]);
  assert.deepEqual(result, {
    models: ['deepseek-chat', 'gpt-4o'],
    baseURL: 'https://relay.example.com/v1',
  });
  assert.ok(!JSON.stringify(result).includes('sk-discover-key'));
});

test('models.discover reports auth failure without leaking key and handles empty lists', async (t) => {
  t.mock.method(global, 'fetch', async () => new Response('{}', { status: 401 }));
  await assert.rejects(
    models.discover({ baseURL: 'https://relay.example.com/v1', apiKey: 'sk-bad-secret' }),
    (err) => err.status === 502 && /API Key/.test(err.message) && !err.message.includes('sk-bad-secret'),
  );

  t.mock.method(global, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  await assert.rejects(
    models.discover({ baseURL: 'https://relay.example.com/v1' }),
    (err) => err.status === 422 && /未返回可用模型/.test(err.message),
  );
});
