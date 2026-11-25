const fs = require('node:fs');
const path = require('node:path');

const SKILL_IDS = [
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

const sourceDir = path.resolve(
  process.env.ALEVEL_SKILLS_DIR || process.argv[2] || 'D:\\Projects\\Alevel\\skills',
);
const targetDir = path.resolve(__dirname, '../skills/question-bank');

if (!fs.existsSync(sourceDir)) {
  console.error(`Source skills directory not found: ${sourceDir}`);
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });

const readmeSrc = path.join(sourceDir, 'README.md');
if (fs.existsSync(readmeSrc)) {
  fs.copyFileSync(readmeSrc, path.join(targetDir, 'README.md'));
}

let synced = 0;
for (const id of SKILL_IDS) {
  const srcSkill = path.join(sourceDir, id);
  const srcMd = path.join(srcSkill, 'SKILL.md');
  if (!fs.existsSync(srcMd)) {
    console.warn(`Skipping missing skill: ${srcMd}`);
    continue;
  }
  const destSkill = path.join(targetDir, id);
  fs.mkdirSync(destSkill, { recursive: true });
  fs.copyFileSync(srcMd, path.join(destSkill, 'SKILL.md'));

  const srcTax = path.join(srcSkill, 'references', 'taxonomy.json');
  if (fs.existsSync(srcTax)) {
    const destRefs = path.join(destSkill, 'references');
    fs.mkdirSync(destRefs, { recursive: true });
    fs.copyFileSync(srcTax, path.join(destRefs, 'taxonomy.json'));
  }
  synced++;
}

console.log(`Synced ${synced} question-bank skills to ${targetDir}`);
