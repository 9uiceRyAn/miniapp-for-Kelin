const crypto = require('node:crypto');
const { fail } = require('./core');
function key() {
  if (!process.env.MEDIA_SIGNING_KEY) fail(503, '尚未配置媒体签名');
  return process.env.MEDIA_SIGNING_KEY;
}
function signature(payload) {
  return crypto.createHmac('sha256', key()).update(payload).digest('hex');
}
function matches(payload, supplied) {
  const expected = Buffer.from(signature(payload));
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
module.exports = { signature, matches };
