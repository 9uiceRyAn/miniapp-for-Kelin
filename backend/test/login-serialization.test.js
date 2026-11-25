const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const express = require('express');
const mysql = require('mysql2/promise');
const { hashPassword } = require('../src/utils/security');

test('password and device logins honor the committed credential reset', {
  skip: !process.env.TEST_MYSQL_PORT,
  timeout: 30000,
}, async t => {
  const port = Number(process.env.TEST_MYSQL_PORT);
  const database = 'kelin_login_test_' + process.pid;
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'root', DB_PASSWORD: '', DB_NAME: database,
  });
  const db = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root' });
  let server, pool;
  t.after(async () => {
    await db.rollback();
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await pool.end();
    await db.query('DROP DATABASE IF EXISTS ' + database);
    await db.end();
  });
  await db.query('CREATE DATABASE ' + database);
  await db.changeUser({ database });
  const baseline = await readFile(path.join(__dirname, 'fixtures/base.sql'), 'utf8');
  for (const sql of baseline.split(';').filter(value => value.trim())) await db.query(sql);
  await db.query(await readFile(path.join(__dirname, '../../database/migrations/009_user_avatar.sql'), 'utf8'));
  const [user] = await db.execute(
    'INSERT INTO users(username,password_hash,role,status) VALUES(?,?,?,1)',
    ['learner', hashPassword('first-password'), 'student'],
  );
  ({ pool } = require('../src/db'));
  const app = express();
  app.use(express.json());
  app.use('/auth', require('../src/routes/auth'));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const post = (route, body) => fetch(origin + '/auth/' + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const login = (password, rememberDevice = true) => post('login', { username: 'learner', password, rememberDevice });
  const me = token => fetch(origin + '/auth/me', { headers: { authorization: 'Bearer ' + token } });
  const initial = await login('first-password');
  assert.equal(initial.status, 200);
  const { data: old } = await initial.json();
  const remembered = await post('remember-login', { rememberToken: old.rememberToken });
  assert.equal(remembered.status, 200);
  const { data: previousDeviceSession } = await remembered.json();

  // Hold the account row through the same password change and revocations used by teacher management.
  await db.beginTransaction();
  await db.execute('UPDATE users SET password_hash=? WHERE id=?', [hashPassword('second-password'), user.insertId]);
  await db.execute('DELETE FROM auth_sessions WHERE user_id=?', [user.insertId]);
  await db.execute('UPDATE remember_devices SET revoked_at=NOW() WHERE user_id=?', [user.insertId]);
  const pending = Promise.all([login('first-password'), post('remember-login', { rememberToken: old.rememberToken })]);
  try {
    // Wait for both requests at the account lock so this exercises overlap on both fast and slow CI hosts.
    const deadline = Date.now() + 10000;
    for (;;) {
      const [[row]] = await db.execute(
        "SELECT COUNT(DISTINCT THREAD_ID) AS waiting FROM performance_schema.data_locks WHERE OBJECT_SCHEMA=? AND OBJECT_NAME='users' AND LOCK_STATUS='WAITING'",
        [database],
      );
      if (Number(row.waiting) === 2) break;
      assert.ok(Date.now() < deadline, 'both login requests should wait for the account transaction');
      await delay(25);
    }
    await db.commit();
  } finally {
    await db.rollback();
    await pending;
  }
  for (const response of await pending) {
    assert.equal(response.status, 401);
    assert.equal((await response.json()).data, undefined);
  }
  assert.equal((await me(old.token)).status, 401);
  assert.equal((await me(previousDeviceSession.token)).status, 401);
  const [[sessions]] = await db.query('SELECT COUNT(*) AS count FROM auth_sessions');
  const [[devices]] = await db.query('SELECT COUNT(*) AS count FROM remember_devices WHERE revoked_at IS NULL');
  assert.equal(sessions.count, 0);
  assert.equal(devices.count, 0);
  const fresh = await login('second-password', false);
  assert.equal(fresh.status, 200);
  const { data } = await fresh.json();
  assert.equal(data.rememberToken, '');
  assert.equal((await me(data.token)).status, 200);
});
