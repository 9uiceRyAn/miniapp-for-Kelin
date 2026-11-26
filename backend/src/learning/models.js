const c = require('./core');
const { estimate } = require('./pricing');
const { bignumber } = require('mathjs');
async function gateway(endpoint, body, method = 'POST') {
  const management = endpoint === '/model/new' || endpoint === '/model/update';
  const key = management
    ? process.env.LITELLM_MODEL_ADMIN_KEY
    : process.env.LITELLM_CALL_KEY;
  if (!process.env.LITELLM_BASE_URL || !key)
    c.fail(503, '尚未配置 LiteLLM 网关');
  const response = await fetch(
    process.env.LITELLM_BASE_URL.replace(/\/$/, '') + endpoint,
    {
      method,
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60000),
    },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) c.fail(502, `模型网关请求失败 (${response.status})`);
  return result;
}
function publicModel(row) {
  const caps = c.json(row.capabilities) || {};
  return {
    ...row,
    enabled: Boolean(row.enabled),
    capabilities: {
      text: true,
      tools: caps.tools !== false,
      vision: true,
      verified: caps.verified || {},
    },
    parameters: c.json(row.parameters),
  };
}
async function list(all = false) {
  return (
    await c.rows(
      'SELECT * FROM kl_models' +
        (all ? '' : ' WHERE enabled=TRUE') +
        ' ORDER BY created_at,id',
    )
  ).map(publicModel);
}
async function resolve(id, allowDisabled = false) {
  const model = await c.one('SELECT * FROM kl_models WHERE id=?', [id]);
  if (!model || (!model.enabled && !allowDisabled))
    c.fail(503, '所选模型不可用，请联系管理员');
  return publicModel(model);
}
function normalizeBaseURL(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed)
    c.fail(400, '请填写有效的 API 网址（需以 http:// 或 https:// 开头）');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    c.fail(400, '请填写有效的 API 网址（需以 http:// 或 https:// 开头）');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    c.fail(400, '请填写有效的 API 网址（需以 http:// 或 https:// 开头）');
  if (parsed.username || parsed.password || /[?#]/.test(trimmed))
    c.fail(400, 'API 网址不能包含登录信息、查询参数或片段');
  let cleaned = parsed.toString().replace(/\/+$/, '');
  cleaned = cleaned.replace(/\/(chat\/completions|models)$/i, '').replace(/\/+$/, '');
  return cleaned;
}
function toLitellmModel(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('openai/') ? trimmed : 'openai/' + trimmed;
}
async function discover(input) {
  const baseURL = normalizeBaseURL(input?.baseURL);
  const apiKey = String(input?.apiKey || '').trim();
  const headers = {
    Accept: 'application/json',
    ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
  };
  let resolvedBaseURL = baseURL;
  let response;
  try {
    response = await fetch(baseURL + '/models', {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404 && !/\/v\d+$/i.test(baseURL)) {
      resolvedBaseURL = baseURL + '/v1';
      response = await fetch(resolvedBaseURL + '/models', {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(15000),
      });
    }
  } catch {
    c.fail(502, '无法连接到该 API 网址，请检查地址是否正确');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      c.fail(502, `获取模型失败 (${response.status})，请先填写有效的 API Key`);
    c.fail(502, `获取模型列表失败 (${response.status})`);
  }
  const body = await response.json().catch(() => ({}));
  const rawItems = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : Array.isArray(body)
        ? body
        : [];
  const ids = Array.from(
    new Set(
      rawItems
        .map((item) => {
          if (typeof item === 'string') return item.trim();
          if (item && typeof item === 'object') {
            return String(item.id || item.name || '').trim();
          }
          return '';
        })
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));
  if (!ids.length)
    c.fail(422, '该接口未返回可用模型，请手动输入模型名');
  return { models: ids, baseURL: resolvedBaseURL };
}
async function create(input) {
  const name = String(input?.name || '').trim();
  const rawBaseURL = String(input?.baseURL || '').trim();
  const upstreamModel = String(input?.upstreamModel || '').trim();
  const apiKey = String(input?.apiKey || '').trim();
  if (!name || !upstreamModel || !apiKey)
    c.fail(400, '请填写显示名称、模型名和 API Key');
  if ([...upstreamModel].length > 191)
    c.fail(400, '模型名不能超过 191 个字符');
  const baseURL = rawBaseURL ? normalizeBaseURL(rawBaseURL) : '';
  const id = c.id(),
    alias = 'kelin-' + id;
  const result = await gateway('/model/new', {
    model_name: alias,
    litellm_params: {
      model: baseURL ? toLitellmModel(upstreamModel) : upstreamModel,
      api_key: apiKey,
      ...(baseURL ? { api_base: baseURL } : {}),
    },
    model_info: { id, mode: 'chat' },
  });
  const remoteId = result.model_info?.id || id;
  await c.rows(
    'INSERT INTO kl_models(id,name,gateway_id,upstream_model,credential_ref,capabilities,parameters) VALUES(?,?,?,?,?,?,?)',
    [
      id,
      name.slice(0, 191),
      alias,
      upstreamModel,
      remoteId,
      JSON.stringify({
        text: true,
        tools: input.capabilities?.tools !== false,
        vision: true,
        verified: {},
      }),
      JSON.stringify(c.parameters(input.parameters || {})),
    ],
  );
  return resolve(id);
}
async function update(id, input) {
  const model = await resolve(id, true);
  if (input.upstreamModel && input.upstreamModel !== model.upstream_model)
    c.fail(409, '更换供应商模型请新增配置，以保留旧会话版本');
  if (
    input.parameters &&
    JSON.stringify(input.parameters) !== JSON.stringify(model.parameters)
  )
    c.fail(409, '推理参数随 Agent 草稿发布；平台模型参数变更请新增配置');
  if (input.apiKey)
    await gateway('/model/update', {
      model_id: model.credential_ref,
      litellm_params: { api_key: input.apiKey },
    });
  await c.rows(
    'UPDATE kl_models SET name=?,enabled=?,capabilities=? WHERE id=?',
    [
      input.name || model.name,
      input.enabled === undefined ? model.enabled : Boolean(input.enabled),
      JSON.stringify(
        input.capabilities
          ? {
              text: true,
              tools: input.capabilities.tools !== false,
              vision: true,
              verified: model.capabilities.verified || {},
            }
          : model.capabilities,
      ),
      id,
    ],
  );
  return resolve(id, true);
}
async function price(modelId, at = new Date()) {
  const row = await c.one(
    'SELECT * FROM kl_prices WHERE model_id=? AND effective_at<=? ORDER BY effective_at DESC,created_at DESC LIMIT 1',
    [modelId, at],
  );
  return row ? { ...row, rates: c.json(row.rates) } : null;
}
async function addPrice(modelId, input) {
  const rates = input.rates || {};
  for (const v of Object.values(rates))
    if (!/^\d+(\.\d+)?$/.test(String(v))) c.fail(400, '单价必须为非负十进制数');
  if (!/^[A-Z]{3}$/.test(input.currency || ''))
    c.fail(400, '需要三字母币种代码');
  const model = modelId === 'tavily' ? null : await resolve(modelId, true);
  // The gateway holds current token prices; immutable application snapshots preserve prior billing.
  if (model && input.currency === 'USD')
    await gateway('/model/update', {
      model_id: model.credential_ref,
      model_info: {
        input_cost_per_token: Number(rates.input || 0) / 1e6,
        output_cost_per_token: Number(rates.output || 0) / 1e6,
        ...(rates.cachedInput !== undefined
          ? { cache_read_input_token_cost: Number(rates.cachedInput) / 1e6 }
          : {}),
      },
    });
  await c.rows(
    'INSERT INTO kl_prices(id,model_id,currency,rates,effective_at) VALUES(?,?,?,?,?)',
    [c.id(), modelId, input.currency, JSON.stringify(rates), new Date()],
  );
  return price(modelId);
}
async function record(context, operation, modelId, usage, pricing, extra = {}) {
  const amount =
    extra.credits !== undefined && pricing?.rates?.credit !== undefined
      ? bignumber(extra.credits).mul(pricing.rates.credit).toFixed(12)
      : estimate(usage, pricing);
  await c.rows(
    'INSERT IGNORE INTO kl_usage(id,operation_key,user_id,agent_id,run_id,purpose,model_id,provider_request_id,data,amount,currency,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      c.id(),
      operation,
      context.user.id,
      context.agentId || null,
      context.runId || null,
      context.purpose || 'student',
      modelId,
      extra.requestId || null,
      JSON.stringify({ usage: usage || null, price: pricing, ...extra }),
      amount,
      pricing?.currency || null,
      amount === null ? 'pending' : 'estimated',
    ],
  );
}
function tokenUsage(usage) {
  return usage ? {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
    cached: usage.prompt_tokens_details?.cached_tokens || 0,
  } : null;
}
async function completion(model, messages, context, options = {}) {
  const pricing = await price(model.id),
    operation = c.id();
  try {
    const result = await gateway('/v1/chat/completions', {
      model: model.gateway_id,
      messages,
      ...Object.fromEntries(
        Object.entries(model.parameters || {}).map(([k, v]) => [
          {
            topP: 'top_p',
            maxOutputTokens: 'max_tokens',
            frequencyPenalty: 'frequency_penalty',
            presencePenalty: 'presence_penalty',
          }[k] || k,
          v,
        ]),
      ),
      ...options,
      stream: false,
      max_retries: 0,
      metadata: {
        spend_logs_metadata: {
          userId: context.user.id,
          runId: context.runId || '',
          operation,
        },
      },
    });
    await record(
      context,
      operation,
      model.id,
      tokenUsage(result.usage),
      pricing,
      { requestId: result.id },
    );
    return result.choices?.[0]?.message?.content || '';
  } catch (e) {
    await record(context, operation, model.id, null, pricing, {
      incomplete: true,
    });
    throw e;
  }
}
async function usage(user, query = {}, scope = 'self') {
  const conditions = [],
    args = [];
  if (scope === 'teacher') {
    c.teacher(user);
    conditions.push(
      'EXISTS(SELECT 1 FROM kl_agents a WHERE a.id=u.agent_id AND a.owner_id=?)',
    );
    args.push(user.id);
  } else if (scope === 'self') {
    conditions.push('u.user_id=?');
    args.push(user.id);
  } else c.teacher(user);
  for (const [key, col] of [
    ['agentId', 'agent_id'],
    ['userId', 'user_id'],
    ['purpose', 'purpose'],
  ])
    if (query[key]) {
      conditions.push(`u.${col}=?`);
      args.push(query[key]);
    }
  if (query.from) {
    conditions.push('u.created_at>=?');
    args.push(new Date(query.from));
  }
  if (query.to) {
    conditions.push('u.created_at<=?');
    args.push(new Date(query.to));
  }
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '',
    p = c.page(query);
  const summary = await c.rows(
    'SELECT currency,status,SUM(amount) amount,COUNT(*) calls FROM kl_usage u' +
      where +
      ' GROUP BY currency,status',
    args,
  );
  const found = await c.rows(
    'SELECT u.*,person.display_name userName,m.name modelName FROM kl_usage u LEFT JOIN users person ON person.id=u.user_id LEFT JOIN kl_models m ON m.id=u.model_id' +
      where +
      ' ORDER BY created_at DESC,id' + c.limitOffset(p),
    args,
  );
  return {
    summary,
    items: found.map((x) => ({ ...x, data: c.json(x.data) })),
    ...p,
  };
}
async function settings() {
  const values = Object.fromEntries(
    (await c.rows('SELECT name,data FROM kl_settings')).map((x) => [
      x.name,
      c.json(x.data),
    ]),
  );
  const fallback =
    values.defaultChatModelId ||
    values.builderModelId ||
    values.visionModelId ||
    process.env.BUILDER_MODEL_ID ||
    null;
  return {
    defaultChatModelId: fallback,
    builderModelId: values.builderModelId || fallback,
    visionModelId:
      values.visionModelId || process.env.VISION_MODEL_ID || fallback,
  };
}
async function probeSingle(user, model, kind) {
  const operation = c.id(),
    pricing = await price(model.id);
  const messages = [
    {
      role: 'user',
      content:
        kind === 'vision'
          ? [
              { type: 'text', text: 'Describe this image briefly.' },
              {
                type: 'image_url',
                image_url: {
                  url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAABHSURBVFiF7dcxCgAwCEPRpPT+V06P4CAly3cWfGQQdZKoWKc5HAAAAJJ0xw57N2FYM/UEAAAAAAAAAADzPfD5bagnAAAAgAeeTgg+4/4RiQAAAABJRU5ErkJggg==',
                },
              },
            ]
          : 'Reply OK.',
    },
  ];
  const extra =
    kind === 'tools'
      ? {
          tools: [
            {
              type: 'function',
              function: {
                name: 'connection_probe',
                description: 'Test function calling.',
                parameters: {
                  type: 'object',
                  properties: {},
                  additionalProperties: false,
                },
              },
            },
          ],
          tool_choice: {
            type: 'function',
            function: { name: 'connection_probe' },
          },
        }
      : {};
  let result;
  try {
    result = await gateway('/v1/chat/completions', {
      model: model.gateway_id,
      messages,
      max_tokens: 64,
      ...extra,
      stream: false,
    });
  } catch (e) {
    await record(
      { user, purpose: 'admin_test' },
      operation,
      model.id,
      null,
      pricing,
      { incomplete: true },
    );
    throw e;
  }
  await record(
    { user, purpose: 'admin_test' },
    operation,
    model.id,
    tokenUsage(result.usage),
    pricing,
    { requestId: result.id },
  );
  const answer = result.choices?.[0]?.message;
  if (
    kind === 'tools' &&
    !answer?.tool_calls?.some((x) => x.function?.name === 'connection_probe')
  )
    c.fail(422, '模型未返回所需工具调用');
  if (kind !== 'tools' && !String(answer?.content || '').trim())
    c.fail(422, '模型没有返回有效内容');
}
async function probe(user, id, kind = 'all') {
  const model = await resolve(id);
  if (kind === 'all') {
    const results = {};
    const verified = { ...(model.capabilities.verified || {}) };
    const passed = [];
    const failed = [];
    for (const k of ['text', 'tools', 'vision']) {
      try {
        await probeSingle(user, model, k);
        verified[k] = new Date().toISOString();
        results[k] = { ok: true };
        passed.push(k);
      } catch (e) {
        results[k] = { ok: false, message: e.message };
        failed.push(k);
        delete verified[k];
      }
    }
    const capabilities = {
      ...model.capabilities,
      text: true,
      tools: true,
      vision: true,
      verified,
    };
    await c.rows('UPDATE kl_models SET capabilities=? WHERE id=?', [
      JSON.stringify(capabilities),
      id,
    ]);
    if (!passed.length) c.fail(422, results.text?.message || '模型连接测试失败');
    return {
      kind: 'all',
      results,
      message: failed.length
        ? `文字/工具/视觉部分通过 (${passed.length}/3)`
        : '全部能力验证通过',
    };
  }
  if (!['text', 'tools', 'vision'].includes(kind)) c.fail(400, '未知能力测试');
  await probeSingle(user, model, kind);
  const capabilities = {
    ...model.capabilities,
    [kind]: true,
    verified: {
      ...model.capabilities.verified,
      [kind]: new Date().toISOString(),
    },
  };
  await c.rows('UPDATE kl_models SET capabilities=? WHERE id=?', [
    JSON.stringify(capabilities),
    id,
  ]);
  return { message: '能力验证通过', kind };
}
module.exports = {
  probe,
  settings,
  list,
  resolve,
  create,
  discover,
  normalizeBaseURL,
  toLitellmModel,
  update,
  price,
  addPrice,
  record,
  completion,
  usage,
};
