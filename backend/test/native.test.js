const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
function loadPage(file, learning, wx = {}) {
  let config;
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, '../../miniprogram/pages', file),
      'utf8',
    ),
    {
      Page: (value) => {
        config = value;
      },
      require: (name) =>
        name.includes('learning')
          ? learning
          : name.includes('storage')
            ? { getUser: () => ({ id: 1, role: 'student' }) }
            : {},
      wx,
      console,
      setTimeout: () => 1,
      clearTimeout: () => {},
      Math,
      Date,
      JSON,
    },
  );
  const page = {
    ...config,
    data: structuredClone(config.data),
    setData(values) {
      for (const [key, value] of Object.entries(values)) {
        const segments = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let node = this.data;
        segments.slice(0, -1).forEach((s) => {
          node = node[s];
        });
        node[segments.at(-1)] = value;
      }
    },
  };
  return page;
}
test('native UTF-8 event decoding preserves Chinese and emoji across network chunk boundaries', () => {
  const sandbox = {
    module: { exports: {} },
    require: () => ({}),
    Uint8Array,
    String,
    Array,
    Math,
    Date,
    JSON,
    wx: {},
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, '../../miniprogram/utils/learning.js'),
      'utf8',
    ),
    sandbox,
  );
  const decode = sandbox.module.exports.decoder(),
    bytes = Buffer.from('题目 🧮 已完成');
  let actual = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = new Uint8Array([bytes[i]]);
    actual += decode(b.buffer);
  }
  assert.equal(actual, '题目 🧮 已完成');
});
test('a stale filter response cannot overwrite a newer native query', async () => {
  const pending = [];
  const page = loadPage('learning/index.js', {
    request: () => new Promise((resolve) => pending.push(resolve)),
    query: () => '',
    error: () => {},
  });
  const first = page.load(true);
  page.data.q = 'new';
  const second = page.load(true);
  pending[1]({ items: [{ id: 'new' }], total: 1 });
  await second;
  pending[0]({ items: [{ id: 'old' }], total: 1 });
  await first;
  assert.equal(page.data.items[0].id, 'new');
});
test('retry after a network failure reuses the native message idempotency key', async () => {
  const sent = [];
  const page = loadPage('chat/chat.js', {
    id: () => 'client-message-1',
    request: async (url, method, body) => {
      if (method === 'POST') {
        sent.push(body);
        if (sent.length === 1) throw new Error('network lost');
        return { runId: 'run-1' };
      }
      return { messages: [] };
    },
    error: () => {},
  });
  page.data.id = 'conversation';
  page.data.text = 'Explain this question';
  await page.send();
  await page.send();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].requestId, sent[1].requestId);
  assert.equal(page.data.runId, 'run-1');
});
test('leaving the native detail page pauses audio and unloading destroys it', () => {
  const page = loadPage('question/detail.js', {});
  let paused = 0,
    destroyed = 0;
  page._audio = { pause: () => paused++, destroy: () => destroyed++ };
  page.onHide();
  page.onUnload();
  assert.equal(paused, 1);
  assert.equal(destroyed, 1);
});

test('students can retry their failed private attachment without receiving public document management controls',async()=>{
 const page=loadPage('question/detail.js',{request:async()=>({resourceId:'private-document',revisionId:'r1',ownerId:1,visibility:'private',status:'failed',media:[]}),url:x=>x,error:()=>{}});
 page.data.id='private-document';await page.load();assert.equal(page.data.canRetry,true);assert.equal(page.data.canManage,false);
});
