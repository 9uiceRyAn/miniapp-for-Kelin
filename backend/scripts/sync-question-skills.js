const fs = require('node:fs');
const path = require('node:path');

const CLASSIFY_SKILL_IDS = [
  'classify-cambridge-biology-9700',
  'classify-cambridge-chemistry-9701',
  'classify-cambridge-chinese-9868',
  'classify-cambridge-computer-science-9618',
  'classify-cambridge-economics-9708',
  'classify-cambridge-further-mathematics-9231',
  'classify-cambridge-mathematics-9709',
  'classify-cambridge-physics-9702',
  'classify-ielts-listening-reading',
  'classify-ielts-writing',
];

const EXTRA_SKILLS_FROM_SOURCE = ['review-and-repair-exam-images'];
const BIG_SKILLS_FROM_OUTPUT = [
  'build-math-question-database',
  'build-ielts-question-database',
];

const sourceDir = path.resolve(
  process.env.ALEVEL_SKILLS_DIR || process.argv[2] || 'D:\\Projects\\Alevel\\skills',
);
const outputSkillsDir = path.resolve(
  process.env.ALEVEL_OUTPUT_SKILLS_DIR || process.argv[3] || path.resolve(sourceDir, '../output/skills'),
);
const targetDir = path.resolve(__dirname, '../skills/question-bank');

if (!fs.existsSync(sourceDir)) {
  console.error(`Source skills directory not found: ${sourceDir}`);
  process.exit(1);
}

function copyDirFiltered(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name === '.DS_Store' || entry.name.endsWith('.pyc')) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirFiltered(srcPath, destPath);
    else if (entry.isFile()) fs.copyFileSync(srcPath, destPath);
  }
}

fs.mkdirSync(targetDir, { recursive: true });

const readmeSrc = path.join(sourceDir, 'README.md');
if (fs.existsSync(readmeSrc)) {
  fs.copyFileSync(readmeSrc, path.join(targetDir, 'README.md'));
}

let synced = 0;
const pairs = [
  ...[...CLASSIFY_SKILL_IDS, ...EXTRA_SKILLS_FROM_SOURCE].map((id) => ({ id, root: sourceDir })),
  ...BIG_SKILLS_FROM_OUTPUT.map((id) => ({ id, root: outputSkillsDir })),
];

for (const { id, root } of pairs) {
  const srcSkill = path.join(root, id);
  const srcMd = path.join(srcSkill, 'SKILL.md');
  if (!fs.existsSync(srcMd)) {
    console.warn(`Skipping missing skill: ${srcMd}`);
    continue;
  }
  const destSkill = path.join(targetDir, id);
  fs.rmSync(destSkill, { recursive: true, force: true });
  copyDirFiltered(srcSkill, destSkill);
  synced++;
}

console.log(`Synced ${synced} question-bank skills to ${targetDir}`);
