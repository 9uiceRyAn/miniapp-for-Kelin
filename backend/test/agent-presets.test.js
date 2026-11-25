const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/learning/core');
const agents = require('../src/learning/agents');

test('teacher_only agent blocks student conversation creation', async t => {
  const origOne = c.one;
  t.after(() => { c.one = origOne; });
  c.one = async (sql) => {
    if (sql.includes('FROM kl_agents')) {
      return {
        id: 'agent-curator',
        status: 'published',
        enabled: 1,
        audience: 'teacher_only',
        tool_permission: 'read_write',
        published_version: 'v1',
      };
    }
    return null;
  };
  await assert.rejects(
    () => agents.conversation({ id: 2, role: 'student' }, 'agent-curator', 'student'),
    /仅教师可使用此助手/,
  );
});
