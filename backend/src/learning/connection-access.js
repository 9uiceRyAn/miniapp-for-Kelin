const c = require('./core');
const { verifyPassword, randomToken, hashToken } = require('../utils/security');
const grants = new Map();
const attempts = new Map();
const lifetime = 15 * 60 * 1000;

function prune(map, now) {
  for (const [key, entry] of map)
    if (entry.expires <= now) map.delete(key);
}

function unlock(req) {
  c.teacher(req.user);
  const hash = process.env.MODEL_MANAGEMENT_PASSWORD_HASH;
  if (!hash) c.fail(503, '尚未配置 API 管理密码');
  const now = Date.now();
  prune(attempts, now);
  prune(grants, now);
  const entry = attempts.get(req.user.id) || { count: 0, expires: now + lifetime };
  if (entry.count >= 5) c.fail(429, '尝试次数过多，请稍后再试');
  if (typeof req.body.password !== 'string' || !verifyPassword(req.body.password, hash)) {
    entry.count++;
    attempts.set(req.user.id, entry);
    c.fail(403, '管理密码错误');
  }
  attempts.delete(req.user.id);
  const token = randomToken();
  grants.set(req.authTokenHash, { hash: hashToken(token), expires: now + lifetime });
  return { token, expiresAt: now + lifetime };
}

function authorize(req, res, next) {
  c.teacher(req.user);
  const grant = grants.get(req.authTokenHash);
  if (!grant || grant.expires <= Date.now() || grant.hash !== hashToken(req.get('X-Management-Token')))
    c.fail(403, '请重新输入 API 管理密码');
  next();
}
module.exports = { unlock, authorize };
