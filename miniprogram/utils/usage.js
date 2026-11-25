const { formatDate } = require('./file');
// Preserve recorded decimal precision; formatting never changes billing data.
function amount(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}
// Dated reference snapshot, not a live exchange rate or a settlement price.
// SAFE / CFETS: https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do
const exchange = { date: '2026-10-30', usdCny: '6.7138' };
const exchangeNote = '参考汇率：1 USD = ' + exchange.usdCny + ' CNY（' + exchange.date + '，非实时）';
// Decimal strings keep tiny charges and values above Number.MAX_SAFE_INTEGER exact.
function decimal(digits, scale) {
  const padded = digits.padStart(scale + 1, '0');
  return amount(scale ? padded.slice(0, -scale) + '.' + padded.slice(-scale) : padded);
}
function cny(value, currency) {
  const text = amount(value);
  if (text === null || !/^\d+(\.\d+)?$/.test(text)) return null;
  if (currency === 'CNY') return text;
  if (currency !== 'USD') return null;
  const rateParts = exchange.usdCny.split('.');
  const multiplier = Number(rateParts.join(''));
  const parts = text.split('.'), scale = (parts[1] || '').length + (rateParts[1] || '').length;
  let carry = 0, result = '';
  for (const digit of parts.join('').split('').reverse()) {
    const n = Number(digit) * multiplier + carry;
    result = String(n % 10) + result;
    carry = Math.floor(n / 10);
  }
  result = (carry ? String(carry) : '') + result;
  return decimal(result.replace(/^0+(?=\d)/, ''), scale);
}
function addAmounts(a, b) {
  const left = a.split('.'), right = b.split('.');
  const scale = Math.max((left[1] || '').length, (right[1] || '').length);
  const x = left[0] + (left[1] || '').padEnd(scale, '0');
  const y = right[0] + (right[1] || '').padEnd(scale, '0');
  let result = '', carry = 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const n = Number(x[x.length - i - 1] || 0) + Number(y[y.length - i - 1] || 0) + carry;
    result = String(n % 10) + result;
    carry = Math.floor(n / 10);
  }
  return decimal((carry ? String(carry) : '') + result, scale);
}
function overview(summary) {
  const currencies = [...new Set(summary.map(x => x.currency).filter(Boolean))];
  const estimates = summary.filter(x => x.status === 'estimated');
  const converted = estimates.map(x => ({ amount: cny(x.amount, x.currency), calls: Number(x.calls || 0) }));
  const known = converted.filter(x => x.amount !== null);
  return {
    cnyAmount: known.length ? known.reduce((total, x) => addAmounts(total, x.amount), '0') : null,
    cnyExcludedCalls: converted.filter(x => x.amount === null).reduce((n, x) => n + x.calls, 0),
    exchangeNote,
    currencies: currencies.map(currency => {
      const estimate = summary.find(x => x.currency === currency && x.status === 'estimated');
      return { currency, amount: estimate ? amount(estimate.amount) : null, cnyAmount: estimate ? cny(estimate.amount, currency) : null, calls: Number(estimate?.calls || 0) };
    }),
    totalCalls: summary.reduce((n, x) => n + Number(x.calls || 0), 0),
    pendingCalls: summary.filter(x => x.status !== 'estimated').reduce((n, x) => n + Number(x.calls || 0), 0),
    unpricedCalls: summary.filter(x => !x.currency).reduce((n, x) => n + Number(x.calls || 0), 0),
  };
}
function row(item) {
  const unpriced = !item.currency;
  const pending = item.status !== 'estimated' || item.amount === null || item.amount === undefined;
  const usage = item.data?.usage || {};
  const purposes = { student: '作业辅导', library: '资料管理', builder: '创建助手', test: '助手试聊', admin_test: '连接验证', parse: '资料识别' };
  return {
    purpose: purposes[item.purpose] || '模型调用',
    status: unpriced ? '未定价' : pending ? '待核实' : '预估',
    statusKey: unpriced ? 'unpriced' : pending ? 'pending' : 'estimated',
    amount: pending ? null : amount(item.amount),
    currency: item.currency || '',
    cnyAmount: pending ? null : cny(item.amount, item.currency),
    model: item.modelName || (item.model_id === 'tavily' ? '联网搜索' : '模型调用'),
    time: formatDate(item.created_at),
    user: item.userName || '未记录',
    input: usage.input ?? '未记录', output: usage.output ?? '未记录', cached: usage.cached ?? '未记录',
    explanation: unpriced ? '尚未配置价格，暂未计入预估费用。' : pending ? '用量或价格信息不完整，金额仍待核实。' : '按本次调用时的价格与用量估算。',
  };
}
function period(from, to) {
  if (!from && !to) return '全部日期';
  return (from || '最早记录') + ' 至 ' + (to || '今天');
}
module.exports = { overview, row, period };
