const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const core = require('../src/learning/core');
const documents = require('../src/learning/documents');
const { prepare } = require('../src/learning/question-input');

test('selected revision supplies all ordered question images, recognizes once per page, and reports missing pages', async t => {
  const q = { revisionId: 'rev-1', title: '几何题', question_text: '求角 A' };
  let images = ['p1','p2'].map(id => ({ id, mime: 'image/png', storage_path: id }));
  const cache = new Map();
  t.mock.method(core, 'rows', async (sql, args) => {
    if (sql.startsWith('INSERT')) { cache.set(args.slice(0,3).join('/'),args[3]); return; }
    assert.match(sql, /NOT IN \('answer','ms','sm'\).*ORDER BY position,id/);
    assert.deepEqual(args,[q.revisionId]);
    return images;
  });
  t.mock.method(core, 'one', async (_, ids) => cache.has(ids.join('/')) ? { body: cache.get(ids.join('/')) } : null);
  t.mock.method(fs, 'readFile', async path => Buffer.from(path.endsWith('p1')?'first':'second'));
  const recognize = t.mock.method(documents, 'vision', async bytes => bytes.toString());
  const direct = await prepare(q,{ capabilities:{ vision:true,verified:{vision:true} } },null,{});
  assert.deepEqual(direct.filter(p=>p.type==='image').map(p=>p.image),['first','second'].map(s=>'data:image/png;base64,'+Buffer.from(s).toString('base64')));
  assert.equal(direct[0].text,q.question_text);
  await assert.rejects(prepare(q,{},null,{}), /第 1 页.*视觉模型/);
  for (let turn=0; turn<2; turn++) {
    const parts = await prepare(q,{},'vision-1',{});
    assert.deepEqual(parts.slice(1).map(p=>p.text.split('\n').pop()),['first','second']);
  }
  assert.equal(recognize.mock.callCount(),2);
  images[1].storage_path=null;
  await assert.rejects(prepare(q,{},'vision-1',{}), /第 2 页.*缺失/);
  images=[];
  assert.deepEqual(await prepare(q,{},null,{}),[{type:'text',text:q.question_text}]);
});
