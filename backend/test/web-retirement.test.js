const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

async function listen(t) {
  const server = require('../src/server').listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('retired web assets, QR login and cookie endpoints return the application 404', async t => {
  const origin = await listen(t);
  const prefix = '/api/auth/wechat/';
  const routes = [
    ...['/account', '/account/', '/account/index.html', '/account/account.js', '/account/workspace.css',
      '/account/collins-logo.png', '/account/admin.html', '/account/admin.js'].map(url => ['GET', url]),
    ...['web/start', 'web/callback?code=fixture&state=fixture', 'web/pending', 'web/me'].map(url => ['GET', prefix + url]),
    ...['link-code', 'web/complete', 'web/link', 'web/logout'].map(url => ['POST', prefix + url]),
  ];
  for (const [method, url] of routes) {
    const response = await fetch(origin + url, { method, redirect: 'manual' });
    assert.equal(response.status, 404, method + ' ' + url);
    assert.equal((await response.json()).message, '接口不存在');
    assert.equal(response.headers.get('set-cookie'), null);
  }
});
