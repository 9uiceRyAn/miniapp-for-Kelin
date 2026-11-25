const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireTeacher } = require('../middleware/auth');
const { hashPassword } = require('../utils/security');
const codes = require('../registration-codes');
const adminGate = require('../learning/connection-access');
const router = express.Router();
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
}, requireAuth, requireTeacher);
router.post('/unlock', wrap(async (req, res) => {
  const data = await adminGate.unlock(req);
  res.json({ success: true, data });
}));
router.use(adminGate.authorize);
router.put('/password', wrap(async (req, res) => {
  res.json({ success: true, data: await adminGate.changePassword(req) });
}));
router.get('/users', wrap(async (req, res) => {
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const where = ['1=1'];
  const values = [];
  if (req.query.q) {
    where.push('(LOCATE(?,username)>0 OR LOCATE(?,display_name)>0)');
    values.push(String(req.query.q).slice(0, 100), String(req.query.q).slice(0, 100));
  }
  if (['teacher', 'student'].includes(req.query.role)) { where.push('role=?'); values.push(req.query.role); }
  if (['0', '1'].includes(req.query.status)) { where.push('status=?'); values.push(Number(req.query.status)); }
  const clause = where.join(' AND ');
  const [count] = await pool.execute('SELECT COUNT(*) total FROM users WHERE ' + clause, values);
  const [users] = await pool.query('SELECT id,username,display_name,role,status FROM users WHERE ' + clause + ' ORDER BY id DESC LIMIT 20 OFFSET ?', [...values, (page - 1) * 20]);
  res.json({ success: true, data: { users, total: count[0].total, page } });
}));
router.patch('/users/:id', wrap(async (req, res) => {
  const { displayName, status, password } = req.body;
  if (displayName !== undefined && (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 30)) fail(400, '显示名长度须为 1–30 位');
  if (status !== undefined && status !== 0 && status !== 1) fail(400, '账号状态无效');
  if (password !== undefined && (typeof password !== 'string' || password.length < 6 || password.length > 72)) fail(400, '密码长度必须为 6–72 位');
  if (displayName === undefined && status === undefined && password === undefined) fail(400, '请选择修改内容');
  if (status === 0 && String(req.params.id) === String(req.user.id)) fail(400, '不能停用自己的账号');
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    await db.execute('SELECT id FROM account_management_lock WHERE id=1 FOR UPDATE');
    // Recheck the actor after acquiring the shared mutation lock.
    const [actors] = await db.execute('SELECT role,status FROM users WHERE id=? FOR UPDATE', [req.user.id]);
    if (!actors[0] || actors[0].role !== 'teacher' || actors[0].status !== 1) fail(403, '教师账号已失效');
    const [users] = await db.execute('SELECT role,status FROM users WHERE id=? FOR UPDATE', [req.params.id]);
    if (!users.length) fail(404, '账号不存在');
    if (status === 0 && users[0].role === 'teacher') {
      const [teachers] = await db.execute("SELECT id FROM users WHERE role='teacher' AND status=1 FOR UPDATE");
      if (teachers.length <= 1 && users[0].status === 1) fail(409, '须保留至少一名可用教师');
    }
    if (displayName !== undefined) await db.execute('UPDATE users SET display_name=? WHERE id=?', [displayName.trim(), req.params.id]);
    if (status !== undefined) await db.execute('UPDATE users SET status=? WHERE id=?', [status, req.params.id]);
    if (password !== undefined) await db.execute('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(password), req.params.id]);
    if (status === 0 || password !== undefined) {
      await db.execute('DELETE FROM auth_sessions WHERE user_id=?', [req.params.id]);
      await db.execute('UPDATE remember_devices SET revoked_at=NOW() WHERE user_id=? AND revoked_at IS NULL', [req.params.id]);
    }
    await db.commit();
    res.json({ success: true, data: {} });
  } catch (error) { await db.rollback(); throw error; }
  finally { db.release(); }
}));
router.get('/codes', wrap(async (req, res) => {
  await codes.ensureCodes();
  const [rows] = await pool.execute('SELECT role,encrypted_code,version FROM registration_codes ORDER BY role');
  res.json({ success: true, data: { codes: rows.map(row => ({ role: row.role, code: codes.decrypt(row.encrypted_code), version: row.version })) } });
}));
router.put('/codes/:role', wrap(async (req, res) => {
  const { code, version } = req.body;
  if (!['teacher', 'student'].includes(req.params.role) || typeof code !== 'string' || code.trim() !== code || code.length < 6 || code.length > 72 || !Number.isInteger(version)) fail(400, '注册码须为 6–72 位且首尾无空格');
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const [rows] = await db.execute('SELECT role,encrypted_code,version FROM registration_codes ORDER BY role FOR UPDATE');
    const current = rows.find(row => row.role === req.params.role);
    if (!current || current.version !== version) fail(409, '注册码已更新，请刷新后重试');
    if (rows.some(row => row.role !== req.params.role && codes.decrypt(row.encrypted_code) === code)) fail(400, '教师码和学生码必须不同');
    await db.execute('UPDATE registration_codes SET encrypted_code=?,version=version+1 WHERE role=?', [codes.encrypt(code), req.params.role]);
    await db.commit();
    res.json({ success: true, data: {} });
  } catch (error) { await db.rollback(); throw error; }
  finally { db.release(); }
}));
module.exports = router;
