const express = require('express');
const { pool, transaction } = require('../db');
const { randomToken, hashToken, verifyPassword } = require('../utils/security');
const router = express.Router();
const { validateCode } = require('../registration-codes');
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(e => {
  if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: '微信或账号已经绑定，请重新登录' });
  next(e);
});
async function official(url) {
  let result;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) fail(502, '微信服务暂不可用');
    result = await response.json();
  } catch { fail(502, '微信服务暂不可用，请重试'); }
  if (result.errcode || !result.openid) fail(401, '微信授权已失效，请重新授权');
  return result;
}
function config() {
  const appid = process.env.WECHAT_MINI_APP_ID;
  const secret = process.env.WECHAT_MINI_APP_SECRET;
  if (!appid || !secret) fail(503, '微信登录尚未配置');
  return { appid, secret };
}
async function session(db, user) {
  if (user.status !== 1) fail(403, '账号已停用');
  const token = randomToken();
  await db.execute('INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 12 HOUR))', [user.id, hashToken(token)]);
  return { token, user: { id: user.id, username: user.username, displayName: user.display_name || user.username, role: user.role, avatarUrl: user.avatar_url || '' } };
}
async function identify(db, appid, identity) {
  const [rows] = await db.execute('SELECT u.* FROM wx_identities i JOIN users u ON u.id=i.user_id WHERE (i.app_id=? AND i.open_id=?) OR (? IS NOT NULL AND i.union_id=?) FOR UPDATE',
    [appid, identity.openid, identity.unionid || null, identity.unionid || null]);
  const ids = new Set(rows.map(u => String(u.id)));
  if (ids.size > 1) fail(409, '微信身份冲突，请联系管理员');
  return rows[0];
}
async function attach(db, user, appid, identity) {
  if (identity.unionid) {
    await db.execute('INSERT IGNORE INTO wx_union_users(union_id,user_id) VALUES(?,?)', [identity.unionid,user.id]);
    const [owners] = await db.execute('SELECT user_id FROM wx_union_users WHERE union_id=? FOR UPDATE', [identity.unionid]);
    if (String(owners[0].user_id) !== String(user.id)) fail(409, '此微信已绑定其他账号，请重新登录');
  }
  const current = await identify(db, appid, identity);
  if (current && String(current.id) !== String(user.id)) fail(409, '此微信已绑定其他账号');
  const [existing] = await db.execute('SELECT * FROM wx_identities WHERE user_id=? AND app_id=? FOR UPDATE', [user.id, appid]);
  if (existing.length && existing[0].open_id !== identity.openid) fail(409, '此账号已绑定其他微信');
  await db.execute('INSERT INTO wx_identities(app_id,open_id,union_id,user_id) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE union_id=COALESCE(union_id,VALUES(union_id))',
    [appid, identity.openid, identity.unionid || null, user.id]);
}
async function enter(appid, identity) {
  return transaction(async db => {
    const user = await identify(db, appid, identity);
    if (user) { await attach(db, user, appid, identity); return session(db, user); }
    const ticket = randomToken();
    await db.execute('INSERT INTO wx_challenges(id,app_id,open_id,union_id,expires_at) VALUES(?,?,?,?,DATE_ADD(NOW(),INTERVAL 5 MINUTE))',
      [hashToken(ticket), appid, identity.openid, identity.unionid || null]);
    return { ticket, needsAccount: true };
  });
}
router.get('/config', (req, res) => res.json({ success: true, data: {
  mini: Boolean(process.env.WECHAT_MINI_APP_ID && process.env.WECHAT_MINI_APP_SECRET)
} }));
router.post('/mini', wrap(async (req, res) => {
  const { appid, secret } = config();
  if (!req.body.code || String(req.body.code).length > 256) fail(400, '缺少微信登录凭证');
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.search = new URLSearchParams({ appid, secret, js_code: req.body.code, grant_type: 'authorization_code' });
  res.json({ success: true, data: await enter(appid, await official(url)) });
}));
async function completeAccount(ticket, { action, username, password, role: requestedRole, registerCode, displayName }) {
  const ticketHash = hashToken(ticket);
  const { appid } = config();
  const [attempt] = await pool.execute('UPDATE wx_challenges SET attempts=attempts+1 WHERE id=? AND app_id=? AND attempts<5 AND expires_at>NOW()', [ticketHash, appid]);
  if (!attempt.affectedRows) fail(401, '绑定已过期或尝试次数过多，请重新微信登录');
  return transaction(async db => {
    const [tickets] = await db.execute('SELECT * FROM wx_challenges WHERE id=? AND expires_at>NOW() FOR UPDATE', [ticketHash]);
    const t = tickets[0];
    if (!t) fail(401, '绑定已过期，请重新微信登录');
    let user;
    if (action === 'bind') {
      const [users] = await db.execute('SELECT * FROM users WHERE username=? FOR UPDATE', [String(username || '')]);
      user = users[0];
      if (!user || !verifyPassword(password, user.password_hash)) fail(401, '用户名或密码错误');
    } else if (action === 'register') {
      const role = requestedRole === 'teacher' ? 'teacher' : 'student';
      if (!(await validateCode(role, registerCode, db))) fail(403, '内部注册码不正确');
      const existing = await identify(db, t.app_id, { openid: t.open_id, unionid: t.union_id });
      if (existing) user = existing;
      else {
        const name = 'wx_' + randomToken(12);
        const nickname = (typeof displayName === 'string' && displayName.trim().slice(0, 30))
          || (role === 'teacher' ? '微信教师' : '微信学生');
        const [created] = await db.execute('INSERT INTO users(username,password_hash,display_name,role,status) VALUES(?,?,?,?,1)',
          [name, '!wechat-only', nickname, role]);
        user = { id: created.insertId, username: name, display_name: nickname, role, status: 1 };
      }
    } else fail(400, '请选择绑定或注册');
    if (user.status !== 1) fail(403, '账号已停用');
    await attach(db, user, t.app_id, { openid: t.open_id, unionid: t.union_id });
    await db.execute('DELETE FROM wx_challenges WHERE id=?', [t.id]);
    return session(db, user);
  });
}
router.post('/complete', wrap(async (req, res) => {
  res.json({ success: true, data: await completeAccount(req.body.ticket, req.body) });
}));
module.exports = router;
