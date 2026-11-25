const test = require('node:test');
const assert = require('node:assert/strict');
const { helpers } = require('../src/routes/drive');

test('drive helpers enforce ownership for students and full control for teachers', () => {
  const teacher = { id: 1, role: 'teacher' };
  const studentA = { id: 2, role: 'student' };
  const studentB = { id: 3, role: 'student' };

  assert.equal(helpers.canMutate(teacher, 2), true);
  assert.equal(helpers.canMutate(teacher, 3), true);
  assert.equal(helpers.canMutate(studentA, 2), true);
  assert.equal(helpers.canMutate(studentA, 3), false);
  assert.equal(helpers.canMutate(studentB, 2), false);
});

test('drive helpers sanitize file and folder names safely', () => {
  assert.equal(helpers.safeName('高数/第一讲:讲义?.pdf'), '高数_第一讲_讲义_.pdf');
  assert.equal(helpers.safeName('   ', '默认目录'), '默认目录');
  assert.equal(helpers.safeExt('Lecture.PDF'), '.pdf');
  assert.equal(helpers.safeExt('noext'), '');
});

test('server storage summary reports disk capacity and upload breakdown', async t => {
  const { pool } = require('../src/db');
  const { getStorageSummary } = require('../src/utils/server-storage');
  const origQuery = pool.query;
  t.after(() => { pool.query = origQuery; });
  pool.query = async () => [[
    { in_trash: 0, cnt: 12, bytes: 5242880 },
    { in_trash: 1, cnt: 2, bytes: 1048576 },
  ]];
  const summary = await getStorageSummary(__dirname);
  assert.ok(summary.disk.totalBytes > 0);
  assert.ok(summary.disk.freeBytes >= 0);
  assert.ok(summary.disk.usedPercent >= 0 && summary.disk.usedPercent <= 100);
  assert.equal(summary.uploads.activeCount, 12);
  assert.equal(summary.uploads.activeBytes, 5242880);
  assert.equal(summary.uploads.trashCount, 2);
  assert.equal(summary.uploads.trashBytes, 1048576);
});
