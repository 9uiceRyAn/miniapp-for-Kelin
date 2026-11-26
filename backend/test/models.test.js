const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db');
const models = require('../src/learning/models');
const pricing = require('../src/learning/pricing');

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

test('matchCatalogPrice matches mainstream models across prefixes, tags, and dates', () => {
  const gpt4o = pricing.matchCatalogPrice('gpt-4o');
  assert.ok(gpt4o);
  assert.equal(gpt4o.currency, 'USD');
  assert.equal(gpt4o.rates.input, '2.5');
  assert.equal(gpt4o.rates.output, '10');

  const prefixed = pricing.matchCatalogPrice('openai/gpt-4o');
  assert.equal(prefixed.matchedModel, 'gpt-4o');

  const deepseek = pricing.matchCatalogPrice('deepseek-ai/DeepSeek-Chat');
  assert.ok(deepseek);
  assert.equal(deepseek.matchedModel, 'deepseek-chat');

  const gemini = pricing.matchCatalogPrice('gemini-2.5-pro-preview-05-06');
  assert.ok(gemini);
  assert.equal(gemini.matchedModel, 'gemini-2.5-pro');

  assert.equal(pricing.matchCatalogPrice('totally-unknown-custom-model-xyz'), null);
  assert.equal(pricing.matchCatalogPrice('gpt-4o-custom-pricing'), null);
  assert.equal(pricing.matchCatalogPrice('constructor'), null);
});

test('models.create auto-seeds matched catalog price and models.list returns currentPrice + matchedPrice', async (t) => {
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

  const calls = [];
  let insertedModel = null;
  let insertedPrice = null;
  t.mock.method(global, 'fetch', async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ model_info: { id: 'remote-4o' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  t.mock.method(pool, 'execute', async (sql, params) => {
    if (sql.startsWith('INSERT INTO kl_models')) {
      insertedModel = {
        id: params[0],
        name: params[1],
        gateway_id: params[2],
        upstream_model: params[3],
        credential_ref: params[4],
        enabled: 1,
        capabilities: params[5],
        parameters: params[6],
      };
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('INSERT INTO kl_prices')) {
      insertedPrice = {
        id: params[0],
        model_id: params[1],
        currency: params[2],
        rates: params[3],
        effective_at: params[4],
      };
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT * FROM kl_models WHERE id=?')) {
      return [[insertedModel]];
    }
    if (sql.startsWith('SELECT * FROM kl_models ORDER BY')) {
      return [[insertedModel]];
    }
    if (sql.startsWith('SELECT * FROM kl_prices WHERE model_id=?')) {
      return [[insertedPrice]];
    }
    if (sql.startsWith('SELECT * FROM kl_prices ORDER BY')) {
      return [[insertedPrice]];
    }
    return [[]];
  });

  const created = await models.create({
    name: 'GPT-4o',
    baseURL: 'https://api.example.com/v1',
    upstreamModel: 'gpt-4o',
    apiKey: 'sk-test',
  });
  assert.ok(calls.some((c) => c.url.endsWith('/model/new')));
  assert.ok(calls.some((c) => c.url.endsWith('/model/update')));
  assert.equal(created.currentPrice.currency, 'USD');
  assert.equal(created.currentPrice.rates.input, '2.5');
  assert.equal(created.matchedPrice.matchedModel, 'gpt-4o');

  const listed = await models.list(true);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].currentPrice.rates.output, '10');
  assert.equal(listed[0].matchedPrice.matchedModel, 'gpt-4o');
});

test('models.remove deletes gateway model, clears settings & agent refs, and preserves usage/prices', async (t) => {
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

  const deletedGatewayIds = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:4000/model/delete');
    deletedGatewayIds.push(JSON.parse(init.body).id);
    return new Response('{}', { status: 404 });
  });

  const executed = [];
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    execute: async (sql, params) => { executed.push({ sql, params }); return [{ affectedRows: 1 }]; },
  };
  t.mock.method(pool, 'getConnection', async () => connection);
  t.mock.method(pool, 'execute', async (sql, params) => {
    executed.push({ sql, params });
    if (sql.startsWith('SELECT * FROM kl_models WHERE id=?')) {
      return [[{ id: 'm1', credential_ref: 'remote-m1' }]];
    }
    return [{ affectedRows: 1 }];
  });

  const res = await models.remove('m1');
  assert.deepEqual(res, { deleted: true, id: 'm1' });
  assert.deepEqual(deletedGatewayIds, ['remote-m1']);
  assert.ok(executed.some((e) => e.sql.startsWith('DELETE FROM kl_settings') && e.sql.includes('JSON_UNQUOTE(data)=?') && e.params[0] === 'm1'));
  assert.ok(executed.some((e) => e.sql.includes('UPDATE kl_agents SET draft_model_id=NULL') && e.params[0] === 'm1'));
  assert.ok(executed.some((e) => e.sql === 'DELETE FROM kl_models WHERE id=?' && e.params[0] === 'm1'));
  assert.ok(!executed.some((e) => e.sql.includes('DELETE FROM kl_usage') || e.sql.includes('DELETE FROM kl_prices')));
});
