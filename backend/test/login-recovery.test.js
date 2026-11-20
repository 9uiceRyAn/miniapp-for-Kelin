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
    assert.deepEqual(data, { ticket: 'ticket', action: 'register', role: 'student', registerCode: 'example' });
    return { token: 'current', user: { id: 2 } };
  });
  await page.wechatComplete();
  assert.equal(storage.getRememberToken(), '');
  assert.equal(storage.getToken(), 'current');
});
