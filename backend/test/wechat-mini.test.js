const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function listen(t) {
  const server = require('../src/server').listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('mini login, registration, binding and teacher access survive web retirement', {
  skip: !process.env.TEST_MYSQL_PORT,
}, async t => {
  const dbName = 'kelin_wx_' + crypto.randomBytes(8).toString('hex');
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_PORT: process.env.TEST_MYSQL_PORT, DB_USER: 'root', DB_PASSWORD: '',
    DB_NAME: dbName, REGISTRATION_CODE_KEY: crypto.randomBytes(32).toString('hex'),
    WECHAT_MINI_APP_ID: 'mini', WECHAT_MINI_APP_SECRET: 'fixture',
  });
  const connection = await require('mysql2/promise').createConnection({
    host: '127.0.0.1', port: Number(process.env.TEST_MYSQL_PORT), user: 'root',
  });
  await connection.query('CREATE DATABASE ' + dbName);
  t.after(async () => {
    await require('../src/db').pool.end();
    await connection.query('DROP DATABASE ' + dbName);
    await connection.end();
  });
  await connection.changeUser({ database: dbName });
  for (const file of ['fixtures/base.sql', '../../database/migrations/003_wechat_identity.sql',
    '../../database/migrations/004_teacher_accounts.sql', '../../database/migrations/009_user_avatar.sql']) {
    const sql = await fs.readFile(path.join(__dirname, file), 'utf8');
    for (const statement of sql.split(';').filter(s => s.trim())) await connection.query(statement);
  }
  const { encrypt } = require('../src/registration-codes');
  await connection.execute('INSERT INTO registration_codes(role,encrypted_code) VALUES(?,?)', ['student', encrypt('student-code')]);
  const { hashPassword, hashToken } = require('../src/utils/security');
  const [teacher] = await connection.execute(
    "INSERT INTO users(username,password_hash,display_name,role,status) VALUES('teacher',?,'Teacher','teacher',1)",
    [hashPassword('teacher-password')],
  );
  const origin = await listen(t);
  const nativeFetch = global.fetch;
  let identity = { openid: 'student-open', unionid: 'student-union' };
  t.mock.method(global, 'fetch', (url, options) => {
    if (new URL(url).origin !== 'https://api.weixin.qq.com') return nativeFetch(url, options);
    assert.equal(new URL(url).pathname, '/sns/jscode2session');
    return Promise.resolve({ ok: true, json: async () => identity });
  });
  async function api(route, status, body, token) {
    const response = await fetch(origin + '/api/' + route, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
      body: body && JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, route + ' ' + JSON.stringify(result));
    return result.data;
  }
  const wx = (route, status, body) => api('auth/wechat/' + route, status, body);
  assert.deepEqual(await wx('config', 200), { mini: true });
  const { ticket } = await wx('mini', 200, { code: 'first' });
  const registration = { ticket, action: 'register', role: 'student', registerCode: 'student-code' };
  await wx('complete', 403, { ...registration, registerCode: 'bad' });
  const student = await wx('complete', 200, { ...registration, displayName: ' 小林 ' });
  assert.equal(student.user.displayName, '小林');
  assert.equal(student.user.role, 'student');
  await wx('complete', 401, registration);
  const returning = await wx('mini', 200, { code: 'again' });
  assert.equal(returning.user.id, student.user.id);
  assert.equal(returning.user.displayName, '小林');
  await api('teacher-admin/users', 403, null, student.token);
  identity = { openid: 'teacher-open' };
  const binding = { ...(await wx('mini', 200, { code: 'bind' })), action: 'bind', username: 'teacher' };
  await wx('complete', 401, { ...binding, password: 'wrong' });
  const bound = await wx('complete', 200, { ...binding, password: 'teacher-password' });
  assert.equal(bound.user.id, teacher.insertId);
  assert.equal((await api('teacher-admin/users', 200, null, bound.token)).total, 2);
  await connection.execute('UPDATE users SET status=0 WHERE id=?', [teacher.insertId]);
  await wx('mini', 403, { code: 'disabled' });
  await connection.execute("INSERT INTO wx_challenges(id,app_id,open_id,expires_at) VALUES(?,'old-web','legacy',DATE_ADD(NOW(),INTERVAL 5 MINUTE))", [hashToken('old-ticket')]);
  await wx('complete', 401, { ...registration, ticket: 'old-ticket' });
  delete process.env.WECHAT_MINI_APP_SECRET;
  assert.deepEqual(await wx('config', 200), { mini: false });
  await wx('mini', 503, { code: 'unconfigured' });
});
