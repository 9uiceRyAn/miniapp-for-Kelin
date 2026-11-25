const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { calculate } = require('../src/learning/tools');
const { estimate } = require('../src/learning/pricing');
test('calculator supports arithmetic and refuses assignment, import and property access', () => {
  assert.equal(calculate('sqrt(81)+2^3'), '17');
  assert.equal(calculate('0.1+0.2'), '0.3');
  for (const expression of ['x=2', 'import("fs")', 'a.b', 'evaluate("1+1")'])
    assert.throws(() => calculate(expression));
});
test('pricing uses decimal arithmetic, separates cached inputs and leaves missing prices pending', () => {
  const p = { rates: { input: '1.25', output: '5', cachedInput: '0.125' } };
  assert.equal(
    estimate({ input: 1000, output: 500, cached: 200 }, p),
    '0.003525000000',
  );
  assert.equal(
    estimate(
      { input: 100, output: 2, cached: 10 },
      { rates: { input: '1', output: '1' } },
    ),
    null,
  );
  assert.equal(estimate({}, p), null);
});

after(() => require('../src/db').pool.end());
