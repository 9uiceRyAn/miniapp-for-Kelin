const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/learning/core');
const curator = require('../src/learning/question-curator');
const management = require('../src/learning/question-management');
const questionSkills = require('../src/learning/question-skills');
const questions = require('../src/learning/questions');
const yauzl = require('yauzl');

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
  assert.equal(skills.length, 13);
  const math = questionSkills.readSkill('classify-cambridge-mathematics-9709');
  assert.equal(math.id, 'classify-cambridge-mathematics-9709');
  assert.ok(math.skillMd.includes('9709'));
  assert.ok(math.taxonomy);
  assert.throws(() => questionSkills.readSkill('../package.json'), { status: 404 });
  assert.ok(questionSkills.catalogPrompt().includes('read_question_skill'));
});

test('buildSkillBundleBuffer packages export skill, valid example, big build/review skills, and all 10 subject skills', async () => {
  questions.validate(questionSkills.exportItemsExample());
  const buf = await questionSkills.buildSkillBundleBuffer();
  assert.ok(Buffer.isBuffer(buf) && buf.length > 1000);
  const zip = await yauzl.fromBufferPromise(buf, { lazyEntries: true });
  const entries = [];
  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', (entry) => {
      entries.push(entry.fileName);
      zip.readEntry();
    });
    zip.readEntry();
  });
  assert.ok(entries.includes('kelin-question-bank-export/SKILL.md'));
  assert.ok(entries.includes('kelin-question-bank-export/references/items-example.json'));
  assert.ok(entries.includes('kelin-question-bank-export/skills/build-math-question-database/SKILL.md'));
  assert.ok(entries.includes('kelin-question-bank-export/skills/build-math-question-database/scripts/math_question_bank.py'));
  assert.ok(entries.includes('kelin-question-bank-export/skills/build-ielts-question-database/SKILL.md'));
  assert.ok(entries.includes('kelin-question-bank-export/skills/build-ielts-question-database/scripts/ielts_question_bank.py'));
  assert.ok(entries.includes('kelin-question-bank-export/skills/review-and-repair-exam-images/SKILL.md'));
  assert.ok(entries.includes('kelin-question-bank-export/skills/classify-cambridge-mathematics-9709/SKILL.md'));
  assert.ok(entries.includes('kelin-question-bank-export/skills/classify-ielts-listening-reading/references/taxonomy.json'));
});
