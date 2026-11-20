const crypto = require('node:crypto');
const { pool } = require('./db');
function key() {
  const value = process.env.REGISTRATION_CODE_KEY;
  if (!/^[a-f0-9]{64}$/i.test(value || '')) {
    throw Object.assign(new Error('注册码加密密钥尚未配置'), { status: 503 });
  }
  return Buffer.from(value, 'hex');
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
function decrypt(value) {
  const data = Buffer.from(value, 'base64');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key(), data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
}
async function ensureCodes(db = pool) {
  for (const role of ['teacher', 'student']) {
    await db.execute('INSERT IGNORE INTO registration_codes(role,encrypted_code) VALUES(?,?)',
      [role, encrypt(crypto.randomBytes(18).toString('base64url'))]);
  }
}
async function validateCode(role, value, db = pool) {
  const [rows] = await db.execute('SELECT encrypted_code FROM registration_codes WHERE role=?', [role]);
  if (!rows.length || typeof value !== 'string') return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(decrypt(rows[0].encrypted_code));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
module.exports = { encrypt, decrypt, ensureCodes, validateCode };
