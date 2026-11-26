const { bignumber } = require('mathjs');
const catalog = require('./model-pricing-catalog.json');

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

function matchCatalogPrice(upstreamModel) {
  const raw = String(upstreamModel || '').trim().toLowerCase();
  if (!raw) return null;

  const models = catalog.models || {};
  const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  const withoutTag = bare.replace(/[:@][^:@]+$/, '');
  const withoutDate = withoutTag.replace(
    /(-(\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}|latest|preview|exp))+$/i,
    '',
  );

  const baseCandidates = [raw, bare, withoutTag, withoutDate];
  const candidates = [];
  const seen = new Set();
  const push = (val) => {
    if (val && !seen.has(val)) {
      seen.add(val);
      candidates.push(val);
    }
  };

  for (const item of baseCandidates) {
    push(item);
    push(item.replace(/(\d)\.(\d)/g, '$1-$2'));
    push(item.replace(/(\d)-(\d)/g, '$1.$2'));
  }

  for (const candidate of candidates) {
    if (Object.hasOwn(models, candidate)) {
      return {
        matchedModel: candidate,
        currency: catalog.currency || 'USD',
        rates: { ...models[candidate] },
        updatedAt: catalog.updatedAt || '',
      };
    }
  }

  return null;
}

module.exports = { estimate, matchCatalogPrice };
