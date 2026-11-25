const { bignumber } = require('mathjs');

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
module.exports = { estimate };
