const fs = require('node:fs');
const path = require('node:path');
const c = require('./core');

const SKILLS_ROOT = path.resolve(__dirname, '../../skills/question-bank');

function parseFrontmatter(markdown) {
  const match = String(markdown || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (!match) return meta;
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) meta[key] = val;
  }
  return meta;
}

function listSkills() {
  if (!fs.existsSync(SKILLS_ROOT)) return [];
  const entries = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(SKILLS_ROOT, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const raw = fs.readFileSync(skillPath, 'utf8');
    const meta = parseFrontmatter(raw);
    const taxonomyPath = path.join(SKILLS_ROOT, entry.name, 'references', 'taxonomy.json');
    skills.push({
      id: entry.name,
      name: meta.name || entry.name,
      description: meta.description || '',
      hasTaxonomy: fs.existsSync(taxonomyPath),
    });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

function readSkill(skillId, options = {}) {
  const id = String(skillId || '').trim();
  const validIds = new Set(listSkills().map((s) => s.id));
  if (!id || !validIds.has(id)) {
    c.fail(404, `未找到题库分类 Skill：${id || '(空)'}`);
  }
  const skillDir = path.join(SKILLS_ROOT, id);
  const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  let taxonomy = null;
  if (options.includeTaxonomy !== false) {
    const taxonomyPath = path.join(skillDir, 'references', 'taxonomy.json');
    if (fs.existsSync(taxonomyPath)) {
      taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));
    }
  }
  return { id, skillMd, taxonomy };
}

function catalogPrompt() {
  const skills = listSkills();
  if (!skills.length) return '';
  const lines = skills.map((s) => `- ${s.id}：${s.description || s.name}`);
  return (
    '\n\n可用学科分类 Skill（导入或分类前请先按科目调用 read_question_skill 读取完整规范与官方 taxonomy）：\n' +
    lines.join('\n')
  );
}

module.exports = { SKILLS_ROOT, listSkills, readSkill, catalogPrompt };
