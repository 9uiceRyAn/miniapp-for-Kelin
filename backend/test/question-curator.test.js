const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/learning/core');
const curator = require('../src/learning/question-curator');
const management = require('../src/learning/question-management');
const questionSkills = require('../src/learning/question-skills');

test('question curator requires teacher role for propose, confirm, and reject', async () => {
  const student = { id: 2, role: 'student' };
  await assert.rejects(() => curator.propose('update_question', {}, { user: student }), /教师/);
  await assert.rejects(() => curator.confirm(student, 'conv-1', 'act-1'), /教师/);
  await assert.rejects(() => curator.reject(student, 'conv-1', 'act-1'), /教师/);
});

test('question curator propose writes a pending confirmation card without mutating questions', async t => {
  const origRows = c.rows;
  let inserted = null;
  t.after(() => { c.rows = origRows; });
  c.rows = async (sql, params) => {
    if (sql.includes('INSERT INTO kl_question_actions')) inserted = { sql, params };
    return [];
  };
  const res = await curator.propose(
    'batch_update',
    { ids: ['q1', 'q2'], action: 'publish' },
    { user: { id: 1, role: 'teacher' }, conversationId: 'conv-1' },
  );
  assert.equal(res.status, 'pending');
  assert.ok(inserted);
  assert.equal(inserted.params[2], 'batch_update');
});

test('batchUpdate validates empty or invalid actions and rejects removed publish/review actions', async () => {
  const teacher = { id: 1, role: 'teacher' };
  await assert.rejects(() => management.batchUpdate(teacher, { ids: [], action: 'add_tags' }), /1–200/);
  await assert.rejects(() => management.batchUpdate(teacher, { ids: ['q1'], action: 'invalid' }), /不支持/);
  await assert.rejects(() => management.batchUpdate(teacher, { ids: ['q1'], action: 'publish' }), /不支持/);
  await assert.rejects(() => management.batchUpdate(teacher, { ids: ['q1'], action: 'approve_review' }), /不支持/);
});

test('question skills catalog loads synced A-Level & IELTS skills and blocks path traversal', () => {
  const skills = questionSkills.listSkills();
  assert.equal(skills.length, 10);
  const math = questionSkills.readSkill('classify-cambridge-mathematics-9709');
  assert.equal(math.id, 'classify-cambridge-mathematics-9709');
  assert.ok(math.skillMd.includes('9709'));
  assert.ok(math.taxonomy);
  assert.throws(() => questionSkills.readSkill('../package.json'), { status: 404 });
  assert.ok(questionSkills.catalogPrompt().includes('read_question_skill'));
});
