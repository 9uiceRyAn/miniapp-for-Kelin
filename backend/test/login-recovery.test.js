const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../../miniprogram/utils/api');
const storage = require('../../miniprogram/utils/storage');

let definition;
global.Page = value => { definition = value; };
require('../../miniprogram/pages/login/login');
delete global.Page;

function loginPage(t) {
  const cache = new Map();
  const destinations = [];
  global.wx = {
    setStorageSync: (key, value) => cache.set(key, value),
    getStorageSync: key => cache.get(key),
    removeStorageSync: key => cache.delete(key),
    reLaunch: options => destinations.push(options.url),
  };
  t.after(() => { delete global.wx; });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values) { Object.assign(this.data, values); },
  };
  return { page, destinations };
}

test('a response from a previous login cannot populate the active account', async t => {
  loginPage(t);
  storage.saveSession({ token: 'first', user: { id: 1 } });
  let finish;
  wx.request = options => { finish = options.success; };
  const pending = api.me();
  storage.saveSession({ token: 'second', user: { id: 2 } });
  finish({ statusCode: 200, data: { success: true, data: { id: 1 } } });
  await assert.rejects(pending, error => error.statusCode === 409);
  assert.equal(storage.getUser().id, 2);
});

test('a network outage preserves both saved login credentials', async t => {
  const { page } = loginPage(t);
  storage.saveSession({ token: 'old', rememberToken: 'device' });
  t.mock.method(api, 'me', async () => { throw new Error('offline'); });
  const refresh = t.mock.method(api, 'rememberLogin', () => assert.fail('unexpected refresh'));
  await page.tryAutoLogin();
  assert.equal(refresh.mock.callCount(), 0);
  assert.equal(storage.getToken(), 'old');
  assert.equal(storage.getRememberToken(), 'device');
  assert.equal(page.data.autoLoggingIn, false);
});

test('an expired session can recover with the remembered device', async t => {
  const { page, destinations } = loginPage(t);
  storage.saveSession({ token: 'expired', rememberToken: 'device' });
  t.mock.method(api, 'me', async () => { throw Object.assign(new Error(), { statusCode: 401 }); });
  t.mock.method(api, 'rememberLogin', async () => ({ token: 'fresh', user: { id: 1 } }));
  await page.tryAutoLogin();
  assert.equal(storage.getToken(), 'fresh');
  assert.equal(storage.getRememberToken(), 'device');
  assert.equal(destinations.length, 1);
});

test('WeChat cannot start a competing login and a departed page cannot restore a session', async t => {
  const { page, destinations } = loginPage(t);
  page.setData({ wechatEnabled: true });
  storage.saveSession({ token: 'previous' });
  const response = Promise.withResolvers();
  t.mock.method(api, 'me', () => response.promise);
  const automatic = page.tryAutoLogin();
  await page.wechatLogin();
  assert.equal(page.data.errorMessage, '');
  page.onUnload();
  storage.saveSession({ token: 'current' });
  response.resolve({ user: { id: 1 } });
  await automatic;
  assert.equal(storage.getToken(), 'current');
  assert.deepEqual(destinations, []);
});

test('WeChat registration omits stale credentials and drops the previous device token', async t => {
  const { page } = loginPage(t);
  storage.saveSession({ rememberToken: 'previous-user-device' });
  page.setData({ username: 'old', password: 'obsolete', wechatTicket: 'ticket',
    wechatAction: 'register', wechatRole: 'student', wechatRegisterCode: 'example' });
  t.mock.method(api, 'request', async ({ data }) => {
    assert.deepEqual(data, { ticket: 'ticket', action: 'register', role: 'student', registerCode: 'example', displayName: '小林' });
    return { token: 'current', user: { id: 2 } };
  });
  await page.wechatComplete({ detail: { value: { displayName: '小林' } } });
  assert.equal(storage.getRememberToken(), '');
  assert.equal(storage.getToken(), 'current');
});

test('WeChat login defaults to register mode with student selected and allows role switching', async t => {
  const { page } = loginPage(t);
  page.setData({ wechatEnabled: true });
  global.wx.login = ({ success }) => success({ code: 'wx-code' });
  t.mock.method(api, 'request', async ({ path, data }) => {
    assert.equal(path, '/api/auth/wechat/mini');
    assert.deepEqual(data, { code: 'wx-code' });
    return { needsAccount: true, ticket: 'wx-ticket' };
  });

  await page.wechatLogin();
  assert.equal(page.data.wechatTicket, 'wx-ticket');
  assert.equal(page.data.wechatAction, 'register');
  assert.equal(page.data.wechatRole, 'student');

  page.wechatRole({ currentTarget: { dataset: { role: 'teacher' } } });
  assert.equal(page.data.wechatRole, 'teacher');
  page.wechatRole({ currentTarget: { dataset: { role: 'admin' } } });
  assert.equal(page.data.wechatRole, 'teacher');
  page.wechatRole({ currentTarget: { dataset: { role: 'student' } } });
  assert.equal(page.data.wechatRole, 'student');
});

test('WeChat registration falls back to wechatDisplayName when form displayName is empty', async t => {
  const { page, destinations } = loginPage(t);
  page.setData({ wechatTicket: 'ticket', wechatAction: 'register', wechatRole: 'teacher', wechatRegisterCode: 't-code' });
  page.onWechatNicknameBlur({ currentTarget: { dataset: { hintId: 'wxNickname' } }, detail: { value: '张老师' } });

  t.mock.method(api, 'request', async ({ data }) => {
    assert.deepEqual(data, { ticket: 'ticket', action: 'register', role: 'teacher', registerCode: 't-code', displayName: '张老师' });
    return { token: 'tok-123', user: { id: 3, displayName: '张老师', role: 'teacher' } };
  });

  await page.wechatComplete({ detail: { value: { displayName: '' } } });
  assert.equal(storage.get(storage.KEYS.USER).displayName, '张老师');
  assert.deepEqual(destinations, ['/pages/learning/index?section=agents']);
});

test('WeChat registration completes with form displayName for student role', async t => {
  const { page, destinations } = loginPage(t);
  page.setData({ wechatTicket: 'ticket', wechatAction: 'register', wechatRole: 'student', wechatRegisterCode: 's-code' });
  t.mock.method(api, 'request', async () => ({ token: 'tok-456', user: { id: 4, displayName: '李同学', role: 'student' } }));

  await page.wechatComplete({ detail: { value: { displayName: '李同学' } } });
  assert.equal(storage.getToken(), 'tok-456');
  assert.deepEqual(destinations, ['/pages/learning/index?section=agents']);
});

test('returning from WeChat binding clears the panel and keeps the ordinary login available', t => {
  const { page } = loginPage(t);
  page.setData({
    username: 'saved-user', rememberDevice: true, loading: true, wechatTicket: 'pending',
    wechatDisplayName: 'Old nickname', wechatRegisterCode: 'old-code', errorMessage: '旧提示',
    showPassword: true, focusedField: 'password',
  });
  page.closeWechatPanel();
  assert.equal(page.data.wechatTicket, 'pending');
  page.setData({ loading: false });
  page.closeWechatPanel();
  for (const field of ['wechatTicket', 'wechatDisplayName', 'wechatRegisterCode', 'errorMessage', 'focusedField']) {
    assert.equal(page.data[field], '', field);
  }
  assert.equal(page.data.username, 'saved-user');
  assert.equal(page.data.rememberDevice, true);
  assert.equal(page.data.showPassword, false);
  const wxml = require('node:fs').readFileSync(require('node:path').join(__dirname,
    '../../miniprogram/pages/login/login.wxml'), 'utf8');
  assert.match(wxml, /wx:if="\{\{!wechatTicket\}\}"/);
  assert.match(wxml, /bindtap="closeWechatPanel"[^>]*>返回账号登录/);
});
