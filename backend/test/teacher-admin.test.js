const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db');
const codes = require('../src/registration-codes');
test('shared registration codes encrypt, detect tampering and validate the requested role', async () => {
  const previousKey = process.env.REGISTRATION_CODE_KEY;
  const execute = pool.execute;
  process.env.REGISTRATION_CODE_KEY = 'ab'.repeat(32);
  try {
    const teacher = codes.encrypt('teacher-test-code');
    assert.equal(codes.decrypt(teacher), 'teacher-test-code');
    assert.notEqual(teacher, codes.encrypt('teacher-test-code'));
    const damaged = Buffer.from(teacher, 'base64');
    damaged[15] ^= 1;
    assert.throws(() => codes.decrypt(damaged.toString('base64')));
    pool.execute = async (sql, params) => [[{ encrypted_code: codes.encrypt(params[0] === 'teacher' ? 'teacher-test-code' : 'student-test-code') }]];
    assert.equal(await codes.validateCode('teacher', 'teacher-test-code'), true);
    assert.equal(await codes.validateCode('student', 'teacher-test-code'), false);
    assert.equal(await codes.validateCode('teacher', undefined), false);
    assert.equal(await codes.validateCode('teacher', 'wrong'), false);
  } finally {
    pool.execute = execute;
    if (previousKey === undefined) delete process.env.REGISTRATION_CODE_KEY;
    else process.env.REGISTRATION_CODE_KEY = previousKey;
  }
});
test('teacher middleware rejects students and admits teachers', () => {
  const { requireTeacher } = require('../src/middleware/auth');
  let status;
  const response = { status(value) { status = value; return this; }, json() {} };
  requireTeacher({ user: { role: 'student' } }, response, () => assert.fail('student admitted'));
  assert.equal(status, 403);
  let passed = false;
  requireTeacher({ user: { role: 'teacher' } }, response, () => { passed = true; });
  assert.equal(passed, true);
});

test('teacher management requires bearer authentication even with a web session cookie', async t => {
  const express = require('express');
  const app = express();
  app.use('/api/teacher-admin', require('../src/routes/teacher-admin'));
  const server = app.listen(0, '127.0.0.1');
  await require('node:events').once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const [method, path] of [['GET', 'users'], ['PUT', 'codes/student']]) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/teacher-admin/' + path, {
      method, headers: { cookie: 'kelin_web=fixture', origin: 'https://api.kelinliuxue.com' },
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).message, '未登录或登录已过期');
  }
});
