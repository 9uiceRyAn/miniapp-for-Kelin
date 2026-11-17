const c = require('./core');
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
  return {
    ...row,
    enabled: Boolean(row.enabled),
    capabilities: c.json(row.capabilities),
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
async function create(input) {
  if (!input.name || !input.upstreamModel || !input.apiKey)
    c.fail(400, '请填写模型名称、供应商模型 ID 和密钥');
  const id = c.id(),
    alias = 'kelin-' + id;
  const result = await gateway('/model/new', {
    model_name: alias,
    litellm_params: {
      model: input.upstreamModel,
      api_key: input.apiKey,
      ...(input.baseURL ? { api_base: input.baseURL } : {}),
    },
    model_info: { id, mode: 'chat' },
  });
  const remoteId = result.model_info?.id || id;
  await c.rows(
    'INSERT INTO kl_models(id,name,gateway_id,upstream_model,credential_ref,capabilities,parameters) VALUES(?,?,?,?,?,?,?)',
    [
      id,
      String(input.name).slice(0, 191),
      alias,
      input.upstreamModel,
      remoteId,
      JSON.stringify({
        text: true,
        tools: Boolean(input.capabilities?.tools),
        vision: Boolean(input.capabilities?.vision),
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
              tools: Boolean(input.capabilities.tools),
              vision: Boolean(input.capabilities.vision),
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
function estimate(usage, pricing) {
  if (!pricing || usage?.input === undefined || usage?.output === undefined)
    return null;
  const { input, output, cached = 0 } = usage,
    r = pricing.rates;
  if (
    r.input === undefined ||
    r.output === undefined ||
    (cached > 0 && r.cachedInput === undefined)
  )
    return null;
  return bignumber(Math.max(0, input - cached))
    .mul(r.input)
    .add(bignumber(output).mul(r.output))
    .add(bignumber(cached).mul(r.cachedInput || 0))
    .div(1000000)
    .toFixed(12);
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
async function completion(model, messages, context, options = {}) {
  await resolve(model.id);
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
    const u = result.usage;
    await record(
      context,
      operation,
      model.id,
      u
        ? {
            input: u.prompt_tokens,
            output: u.completion_tokens,
            cached: u.prompt_tokens_details?.cached_tokens || 0,
          }
        : null,
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
  } else await c.admin(user);
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
      ' ORDER BY created_at DESC,id LIMIT ' +
      p.pageSize +
      ' OFFSET ' +
      p.offset,
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
  return {
    builderModelId:
      values.builderModelId || process.env.BUILDER_MODEL_ID || null,
    visionModelId: values.visionModelId || process.env.VISION_MODEL_ID || null,
  };
}
async function probe(user, id, kind = 'text') {
  const model = await resolve(id),
    operation = c.id(),
    pricing = await price(id);
  if (!['text', 'tools', 'vision'].includes(kind)) c.fail(400, '未知能力测试');
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
                  url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1cAAAAASUVORK5CYII=',
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
      id,
      null,
      pricing,
      { incomplete: true },
    );
    throw e;
  }
  const usage = result.usage;
  await record(
    { user, purpose: 'admin_test' },
    operation,
    id,
    usage
      ? {
          input: usage.prompt_tokens,
          output: usage.completion_tokens,
          cached: usage.prompt_tokens_details?.cached_tokens || 0,
        }
      : null,
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
  gateway,
  list,
  resolve,
  create,
  update,
  price,
  addPrice,
  estimate,
  record,
  completion,
  usage,
};
