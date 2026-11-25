const c = require('./core');
const { verifyPassword, hashPassword, randomToken, hashToken } = require('../utils/security');
const grants = new Map();
const attempts = new Map();
const lifetime = 15 * 60 * 1000;

function prune(map, now) {
  for (const [key, entry] of map)
    if (entry.expires <= now) map.delete(key);
}

async function credential() {
  const row = await c.one('SELECT password_hash FROM management_password WHERE id=1');
  return row?.password_hash ||
    process.env.ADMIN_MANAGEMENT_PASSWORD_HASH ||
    process.env.MODEL_MANAGEMENT_PASSWORD_HASH;
}

async function unlock(req) {
  c.teacher(req.user);
  const hash = await credential();
  if (!hash) c.fail(503, '尚未配置管理员密码');
  const now = Date.now();
  prune(attempts, now);
  prune(grants, now);
  const entry = attempts.get(req.user.id) || { count: 0, expires: now + lifetime };
  if (entry.count >= 5) c.fail(429, '尝试次数过多，请稍后再试');
  if (typeof req.body.password !== 'string' || !verifyPassword(req.body.password, hash)) {
    entry.count++;
    attempts.set(req.user.id, entry);
    c.fail(403, '管理员密码错误');
  }
  attempts.delete(req.user.id);
  const token = randomToken();
  grants.set(req.authTokenHash, { hash: hashToken(token), credential: hash, expires: now + lifetime });
  return { token, expiresAt: now + lifetime };
}

async function authorize(req, res, next) {
  c.teacher(req.user);
  const grant = grants.get(req.authTokenHash);
  if (!grant || grant.expires <= Date.now() || grant.hash !== hashToken(req.get('X-Management-Token')) || grant.credential !== await credential()) {
    const err = new Error('请输入管理员密码');
    err.status = 403;
    err.code = 'MANAGEMENT_LOCKED';
    throw err;
  }
  req.managementCredential = grant.credential;
  next();
}

async function changePassword(req) {
  const { currentPassword, newPassword } = req.body;
  if (typeof currentPassword !== 'string' || !verifyPassword(currentPassword, req.managementCredential))
    c.fail(403, '当前管理员密码错误');
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 72)
    c.fail(400, '新管理员密码须为 8–72 位');
  if (currentPassword === newPassword) c.fail(400, '新密码与当前密码相同');
  const result = await c.rows('UPDATE management_password SET password_hash=? WHERE id=1 AND (password_hash IS NULL OR password_hash=?)',
    [hashPassword(newPassword), req.managementCredential]);
  if (!result.affectedRows) c.fail(409, '管理员密码已变更，请重新解锁');
  grants.clear();
  return {};
}
module.exports = { unlock, authorize, changePassword };
