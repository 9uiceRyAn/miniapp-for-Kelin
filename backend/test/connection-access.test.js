const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword } = require('../src/utils/security');
const { unlock, authorize } = require('../src/learning/connection-access');

test('management grant requires teacher, correct password, same active session and unexpired window', t => {
  const previous = process.env.MODEL_MANAGEMENT_PASSWORD_HASH;
  t.after(() => { if(previous) process.env.MODEL_MANAGEMENT_PASSWORD_HASH=previous; else delete process.env.MODEL_MANAGEMENT_PASSWORD_HASH; });
  process.env.MODEL_MANAGEMENT_PASSWORD_HASH=hashPassword('test-password');
  const req={ user:{id:1,role:'teacher'}, authTokenHash:'session1', body:{password:'test-password'} };
  assert.throws(()=>unlock({...req,user:{role:'student'}}),/教师/);
  const grant=unlock(req);
  req.get=()=>grant.token;
  let allowed=false;
  authorize(req,{},()=>{allowed=true});
  assert.ok(allowed);
  assert.throws(()=>authorize({...req,authTokenHash:'session2'},{},()=>{}),/管理密码/);
  t.mock.method(Date,'now',()=>grant.expiresAt);
  assert.throws(()=>authorize(req,{},()=>{}),/管理密码/);
  req.body.password='incorrect';
  for(let i=0;i<5;i++) assert.throws(()=>unlock(req),/密码错误/);
  assert.throws(()=>unlock(req),/尝试次数/);
});
