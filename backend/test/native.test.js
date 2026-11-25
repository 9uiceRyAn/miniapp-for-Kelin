const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
function loadPage(file, learning, wx = {}, api = {}) {
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
        name.includes('input-hints')
          ? require(path.join(__dirname, '../../miniprogram/utils/input-hints.js'))
          : name.includes('workspace') ? require(path.join(__dirname, '../../miniprogram/utils/workspace.js'))
          : name.includes('learning')
          ? learning
          : name.includes('storage')
            ? { getUser: () => ({ id: 1, role: 'student' }) }
            : name.endsWith('/api') ? api : {},
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
    require: () => ({ getToken: () => 'test' }),
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
  let chunk;
  const received = [];
  sandbox.wx.request = () => ({ onChunkReceived(cb) { chunk = cb; } });
  sandbox.module.exports.subscribe('run', 0, event => received.push(event.text), assert.ifError);
  const bytes = Buffer.from(JSON.stringify({ text: '题目 🧮 已完成' }) + '\n');
  for (const byte of bytes) chunk({ data: Uint8Array.of(byte).buffer });
  assert.deepEqual(received, ['题目 🧮 已完成']);
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

test('stream fragment animation preserves all text and ignores replayed events', () => {
  const page = loadPage('chat/chat.js', {});
  page._sequence = 0;
  page.consume({ seq: 1, type: 'text-delta', data: { text: '先读题 🧮\n' } });
  page.consume({ seq: 2, type: 'text-delta', data: { text: '再计算 72/1000。' } });
  assert.equal(page.data.streamHead + page.data.streamTail, '先读题 🧮\n再计算 72/1000。');
  assert.equal(page.data.partial, page.data.streamHead + page.data.streamTail);
  const tick = page.data.streamTick;
  page.consume({ seq: 2, type: 'text-delta', data: { text: '重复片段' } });
  assert.equal(page.data.streamTick, tick);
  assert.equal(page.data.partial, '先读题 🧮\n再计算 72/1000。');
});

test('native chat decodes the landing question once without changing literal percent text', async () => {
  for (const text of ['为什么 H+ 与 OH− 会生成水？ 50% 与 %20', '计算 50%']) {
    const page = loadPage('chat/chat.js', { guard: () => true }, { getStorageSync: () => '' });
    page.load = async () => {};
    page.loadRecent = async () => {};
    let sent;
    page.send = async () => { sent = page.data.text; };
    await page.onLoad({ id: 'test-conversation', initialText: text === '计算 50%' ? text : encodeURIComponent(text) });
    assert.equal(sent, text);
  }
});

test('question reading keeps paper metadata compact and switches answer media without mixing revisions', async () => {
  const item = { id: '9708-11-2020-MJ-Q01', sourceId: '9708-11-2020-MJ-Q01', title: '9708 · 2020 MJ · Paper 11 · Question 1', primary_tag_name: 'AS Unit 1 · 基础经济概念与资源配置', question_range: { start: 1, end: 1 }, details: { syllabus_code: '9708', year: 2020, session: 'MJ', paper: '11' }, source_ref: { question_document: '9708_s20_qp_11.pdf', question_pages: [2] }, revisionId: 'r1', media: [
    { id: 'q', kind: 'question', mime: 'image/png', path: '/q.png', available: true },
    { id: 'a', kind: 'answer', mime: 'image/png', path: '/a.png', available: true },
    { id: 'context', kind: 'source', mime: 'application/pdf', path: '/context.pdf', available: true },
    { id: 'mark', kind: 'ms', mime: 'application/pdf', path: '/mark.pdf', available: true },
  ], chunks: [] };
  const page = loadPage('question/detail.js', { request: async () => structuredClone(item), url: x => 'https://local.test' + x });
  await page.load();
  assert.equal(page.data.questionHeading, '第 1 题');
  assert.equal(page.data.paperSummary, '9708 · 2020 MJ · Paper 11');
  assert.equal(page.data.item.sourceText, '9708_s20_qp_11.pdf · 第 2 页');
  assert.equal(page.data.detailsOpen, false);
  assert.deepEqual([...page.data.visibleImages].map(x => x.id), ['q']);
  page.toggleAnswers();
  assert.deepEqual([...page.data.visibleImages].map(x => x.id), ['a']);
  assert.equal(page.data.visibleOtherMedia[0].originalIndex, 1);
  page.preview({ currentTarget: { dataset: { url: 'https://local.test/a.png' } } });
  assert.equal(page.data.previewOpen, true);
  assert.equal(page.data.previewIndex, 0);
  assert.deepEqual([...page.data.previewImages].map(x => x.url), ['https://local.test/a.png']);
  page.closePreview();
  assert.equal(page.data.previewOpen, false);
  assert.equal(page.data.previewImages.length, 0);
  page.toggleAnswers();
  assert.deepEqual([...page.data.visibleImages].map(x => x.id), ['q']);
});
test('tutor sheet enters a conversation with the selected immutable question revision', async () => {
  const routes = [];
  const page = loadPage('question/detail.js', { request: async () => ({ items: [{ id: 'tutor', name: '作业大师' }] }), go: x => routes.push(x) });
  page.setData({ id: 'question-resource', revisionId: 'question-revision' });
  await page.ask();
  assert.equal(page.data.choosing, true);
  assert.equal(page.data.loadingTutors, false);
  page.enter('conversation');
  assert.equal(page.data.choosing, false);
  assert.equal(routes[0], '/pages/chat/chat?id=conversation&questionId=question-resource&revisionId=question-revision');
});

test('text-only question answers remain available without answer images', async () => {
  const item = { title: 'Typed question', question_text: 'Calculate 2 + 2.', answer_text: '4', media: [], chunks: [], revisionId: 'typed-revision', status: 'ready' };
  const page = loadPage('question/detail.js', { request: async () => item, url: value => value, error: error => { throw error; } });
  page.setData({ id: 'typed-question' });
  await page.load();
  assert.equal(page.data.item.hasAnswer, true);
  page.toggleAnswers();
  assert.equal(page.data.answers, true);
  assert.equal(page.data.item.answer_text, '4');
});

test('studio agent preset manager loads list, validates prompt, and saves minimal preset edits', async () => {
  let savedPayload = null;
  const page = loadPage('studio/studio.js', {
    guard: () => true,
    query: obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined)).toString(),
    request: async (url, method, body) => {
      if (method === 'PUT') { savedPayload = body; return { id: 'tutor' }; }
      if (url.startsWith('/api/ai/agents?')) return { items: [{ id: 'tutor', name: 'Tutor', tool_permission: 'read_only', audience: 'all', enabled: 1 }] };
      return { id: 'tutor', name: 'Tutor', description: 'Desc', tool_permission: 'read_only', audience: 'all', enabled: 1, skill: { content: 'Original prompt' } };
    },
    error: error => { throw error; },
  }, {
    showToast() {},
  });

  await page.load();
  assert.equal(page.data.items.length, 1);
  await page.openEdit({ currentTarget: { dataset: { id: 'tutor' } } });
  assert.equal(page.data.sheetOpen, true);
  assert.equal(page.data.form.content, 'Original prompt');

  page.formInput({ currentTarget: { dataset: { field: 'content' } }, detail: { value: '' } });
  await page.save();
  assert.equal(savedPayload, null);
  assert.equal(page.data.formError, '请输入 Prompt');

  page.formInput({ currentTarget: { dataset: { field: 'content' } }, detail: { value: 'Updated prompt' } });
  page.formSelect({ currentTarget: { dataset: { field: 'toolPermission', value: 'read_write' } } });
  page.formSelect({ currentTarget: { dataset: { field: 'audience', value: 'teacher_only' } } });
  await page.save();
  assert.equal(savedPayload.content, 'Updated prompt');
  assert.equal(savedPayload.toolPermission, 'read_write');
  assert.equal(savedPayload.audience, 'teacher_only');
  assert.equal(page.data.sheetOpen, false);
});

test('native chat preserves text typed during a send and ignores a second tap', async () => {
  const sent = [];
  let completeSend;
  const page = loadPage('chat/chat.js', {
    id: () => 'message',
    request: async (url, method, body) => {
      if (method !== 'POST') return { messages: [] };
      sent.push(body.text);
      return new Promise(resolve => { completeSend = resolve; });
    },
    error: error => { throw error; },
  });

  page.setData({ text: 'First message' });
  const sending = page.send();
  page.input({ detail: { value: 'Next message' } });
  await page.send();
  completeSend({ runId: 'run' });
  await sending;

  assert.deepEqual(sent, ['First message']);
  assert.equal(page.data.text, 'Next message');
  assert.equal(page.data.sending, false);
});

test('native chat subscribes to an accepted run even if reloading messages fails', async () => {
  const subscribed = [];
  const page = loadPage('chat/chat.js', {
    id: () => 'message',
    request: async (url, method) => {
      if (method === 'POST') return { runId: 'run' };
      throw new Error('Message refresh failed');
    },
    subscribe: (runId) => { subscribed.push(runId); return {}; },
    error() {},
  });
  page._visible = true;
  page.setData({ text: 'First message' });
  await page.send();

  assert.deepEqual(subscribed, ['run']);
  assert.equal(page.data.running, true);
});

test('opening a saved conversation from a question keeps the selected revision and restores draft text', async () => {
  const page = loadPage('chat/chat.js', {
    guard: () => true,
    request: async () => ({ resourceId: 'new-question', revisionId: 'new-revision', title: 'Selected question' }),
  }, {
    getStorageSync: () => ({
      text: 'Previous draft',
      question: { resourceId: 'old-question', revisionId: 'old-revision' },
    }),
  });
  page.load = async () => {};
  page.loadRecent = async () => {};
  await page.onLoad({ id: 'conversation', questionId: 'new-question', revisionId: 'new-revision' });

  assert.equal(page.data.question.resourceId, 'new-question');
  assert.equal(page.data.question.revisionId, 'new-revision');
  assert.equal(page.data.text, 'Previous draft');
});

test('a late reply for an A–E category cannot replace files under the new category', async () => {
  const resolveFiles = new Map();
  const page = loadPage('learning/index.js', {}, {}, {
    files: category => new Promise(resolve => { resolveFiles.set(category, resolve); }),
  });
  const first = page.existing();
  const second = page.category({ detail: { value: 1 } });
  assert.equal(page.data.existingFiles.length, 0);
  resolveFiles.get('B')([{ id: 'file-b' }]);
  await second;
  resolveFiles.get('A')([{ id: 'file-a' }]);
  await first;

  assert.equal(page.data.category, 'B');
  assert.equal(page.data.existingFiles[0].id, 'file-b');
});

test('the native tutor sheet requests another page for the same selected assistant', async () => {
  const requested = [];
  const page = loadPage('question/detail.js', {
    query: fields => new URLSearchParams(fields).toString(),
    request: async url => {
      requested.push(url);
      return requested.length === 1
        ? Array.from({ length: 20 }, (_, id) => ({ id }))
        : [{ id: 20 }];
    },
  });
  page.setData({ tutors: [{ id: 'tutor' }], tutorIndex: 0 });
  await page.chooseExisting();
  await page.chooseExisting();

  assert.match(requested[0], /agentId=tutor&page=1/);
  assert.match(requested[1], /agentId=tutor&page=2/);
  assert.equal(page.data.existing.length, 21);
  assert.equal(page.data.existingHasMore, false);
});
