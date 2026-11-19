const crypto = require('node:crypto');
const { pool, transaction } = require('../db');
const id = () => crypto.randomUUID();
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const json = (value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}
async function rows(sql, values = [], db = pool) {
  return (await db.execute(sql, values))[0];
}
async function one(sql, values = [], db = pool) {
  return (await rows(sql, values, db))[0];
}
async function capability(user, name = 'platform_admin') {
  return Boolean(
    await one(
      'SELECT user_id FROM kl_capabilities WHERE user_id=? AND capability=?',
      [user.id, name],
    ),
  );
}
async function admin(user) {
  if (!(await capability(user))) fail(403, '需要平台管理员权限');
}
function teacher(user) {
  if (user.role !== 'teacher') fail(403, '需要教师权限');
}
function page(query = {}) {
  const number = Math.max(1, Math.floor(Number(query.page) || 1));
  const size = Math.min(
    100,
    Math.max(1, Math.floor(Number(query.pageSize) || 20)),
  );
  return { page: number, pageSize: size, offset: (number - 1) * size };
}
const route = (fn) => async (req, res, next) => {
  try {
    res.json({ success: true, data: await fn(req, res) });
  } catch (e) {
    next(e);
  }
};
function parameters(input = {}) {
  const allowed = {
    temperature: [0, 2],
    topP: [0, 1],
    maxOutputTokens: [1, 32000],
    frequencyPenalty: [-2, 2],
    presencePenalty: [-2, 2],
  };
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    const range = allowed[key];
    if (
      !range ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < range[0] ||
      value > range[1]
    )
      fail(400, '无效的推理参数: ' + key);
    result[key] = value;
  }
  return result;
}
module.exports = {
  parameters,
  pool,
  id,
  hash,
  json,
  fail,
  rows,
  one,
  transaction,
  capability,
  admin,
  teacher,
  page,
  route,
};
