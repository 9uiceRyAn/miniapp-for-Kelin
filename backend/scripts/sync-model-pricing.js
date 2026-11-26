const fs = require('node:fs/promises');
const path = require('node:path');

const SOURCE_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OUTPUT_PATH = path.resolve(
  __dirname,
  '../src/learning/model-pricing-catalog.json',
);

const DIRECT_PREFIXES = new Set([
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'xai',
  'dashscope',
  'moonshot',
  'volcengine',
  'zai',
  'zhipu',
  'mistral',
  'cohere',
  'perplexity',
]);

function formatPerMillion(perToken) {
  const perMillion = Number(perToken) * 1e6;
  if (!Number.isFinite(perMillion) || perMillion < 0) return null;
  const fixed = perMillion.toFixed(6).replace(/\.?0+$/, '');
  return fixed || '0';
}

function normalizeModelKey(rawKey) {
  let key = String(rawKey || '').trim().toLowerCase();
  if (!key || key === 'sample_spec' || key.startsWith('ft:') || key.includes('/ft:')) {
    return null;
  }

  let priority = 3; // 3 = bare official, 2 = direct provider prefix, 1 = wrapper/cloud
  const slashIdx = key.indexOf('/');
  if (slashIdx > 0) {
    const firstSeg = key.slice(0, slashIdx);
    priority = DIRECT_PREFIXES.has(firstSeg) ? 2 : 1;
    key = key.slice(key.lastIndexOf('/') + 1);
  }

  // Strip Bedrock-style vendor prefix & version suffix: anthropic.claude-3-5-sonnet-20241022-v2:0
  if (key.startsWith('anthropic.')) {
    key = key.slice('anthropic.'.length);
    if (priority === 3) priority = 1;
  }
  if (key.startsWith('qwen.') || key.startsWith('deepseek.') || key.startsWith('meta.')) {
    key = key.slice(key.indexOf('.') + 1);
    if (priority === 3) priority = 1;
  }
  key = key.replace(/-v\d+:\d+$/, '');

  // Strip wrapper tags like :free, :exacto, @preset
  key = key.replace(/:(free|exacto|thinking|extended)$/i, '');

  if (!key || key.length < 2) return null;
  return { canonical: key, priority };
}

async function main() {
  const response = await fetch(SOURCE_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch LiteLLM catalog: ${response.status}`);
  }
  const raw = await response.json();
  const best = new Map();

  for (const [rawKey, entry] of Object.entries(raw || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.mode !== 'chat' && entry.mode !== 'responses') continue;
    if (
      typeof entry.input_cost_per_token !== 'number' ||
      typeof entry.output_cost_per_token !== 'number' ||
      entry.input_cost_per_token < 0 ||
      entry.output_cost_per_token < 0
    ) {
      continue;
    }

    const norm = normalizeModelKey(rawKey);
    if (!norm) continue;

    const input = formatPerMillion(entry.input_cost_per_token);
    const output = formatPerMillion(entry.output_cost_per_token);
    if (input === null || output === null) continue;

    const rates = { input, output };
    if (
      typeof entry.cache_read_input_token_cost === 'number' &&
      entry.cache_read_input_token_cost >= 0
    ) {
      const cachedInput = formatPerMillion(entry.cache_read_input_token_cost);
      if (cachedInput !== null) rates.cachedInput = cachedInput;
    }

    const prev = best.get(norm.canonical);
    if (!prev || norm.priority > prev.priority) {
      best.set(norm.canonical, { priority: norm.priority, rates });
    }
  }

  const sortedModels = {};
  for (const key of Array.from(best.keys()).sort((a, b) => a.localeCompare(b))) {
    sortedModels[key] = best.get(key).rates;
  }

  const payload = {
    source: SOURCE_URL,
    updatedAt: new Date().toISOString().slice(0, 10),
    currency: 'USD',
    count: Object.keys(sortedModels).length,
    models: sortedModels,
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`Synced ${payload.count} models to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
