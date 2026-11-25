const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword } = require('../src/utils/security');
const { unlock, authorize } = require('../src/learning/connection-access');

const { pool } = require('../src/db');

test('management grant requires teacher, correct password, same active session and unexpired window', async t => {
  t.mock.method(pool, 'execute', async () => [[]]);
  const previous = process.env.MODEL_MANAGEMENT_PASSWORD_HASH;
  t.after(() => { if(previous) process.env.MODEL_MANAGEMENT_PASSWORD_HASH=previous; else delete process.env.MODEL_MANAGEMENT_PASSWORD_HASH; });
  process.env.MODEL_MANAGEMENT_PASSWORD_HASH=hashPassword('test-password');
  const req={ user:{id:1,role:'teacher'}, authTokenHash:'session1', body:{password:'test-password'} };
  await assert.rejects(unlock({...req,user:{role:'student'}}),/教师/);
  const grant=await unlock(req);
  req.get=()=>grant.token;
  let allowed=false;
  await authorize(req,{},()=>{allowed=true});
  assert.ok(allowed);
  await assert.rejects(authorize({...req,authTokenHash:'session2'},{},()=>{}),/管理员密码/);
  t.mock.method(Date,'now',()=>grant.expiresAt);
  await assert.rejects(authorize(req,{},()=>{}),/管理员密码/);
  req.body.password='incorrect';
  for(let i=0;i<5;i++) await assert.rejects(unlock(req),/密码错误/);
  await assert.rejects(unlock(req),/尝试次数/);
});

test('shared password rotation supersedes the configured password and revokes existing grants', async t => {
  let stored = null;
  t.mock.method(pool, 'execute', async (sql, params) => {
    if (sql.startsWith('UPDATE')) {
      stored = params[0];
      return [{ affectedRows: 1 }];
    }
    return [[{ password_hash: stored }]];
  });
  const prevAdmin = process.env.ADMIN_MANAGEMENT_PASSWORD_HASH;
  const prevModel = process.env.MODEL_MANAGEMENT_PASSWORD_HASH;
  t.after(() => {
    if (prevAdmin) process.env.ADMIN_MANAGEMENT_PASSWORD_HASH = prevAdmin;
    else delete process.env.ADMIN_MANAGEMENT_PASSWORD_HASH;
    if (prevModel) process.env.MODEL_MANAGEMENT_PASSWORD_HASH = prevModel;
    else delete process.env.MODEL_MANAGEMENT_PASSWORD_HASH;
  });
  process.env.ADMIN_MANAGEMENT_PASSWORD_HASH = hashPassword('shared-admin-pass');
  process.env.MODEL_MANAGEMENT_PASSWORD_HASH = hashPassword('old-model-pass');
  const req = { user: { id: 99, role: 'teacher' }, authTokenHash: 's99', body: { password: 'shared-admin-pass' } };
  const grant = await unlock(req);
  assert.ok(grant.token);
  req.get = () => grant.token;
  await authorize(req, {}, () => {});
  req.body = { currentPassword: 'shared-admin-pass', newPassword: 'replacement-pass' };
  await require('../src/learning/connection-access').changePassword(req);
  await assert.rejects(authorize(req, {}, () => {}), /管理员密码/);
  req.body.password = req.body.currentPassword;
  await assert.rejects(unlock(req), /密码错误/);
  req.body.password = req.body.newPassword;
  assert.ok((await unlock(req)).token);
});
