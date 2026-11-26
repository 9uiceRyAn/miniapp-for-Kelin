const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { ZipArchive } = require('archiver');
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

function exportSkillMarkdown() {
  const skills = listSkills();
  const coreBigSkills = skills.filter((s) => !s.id.startsWith('classify-'));
  const classifySkills = skills.filter((s) => s.id.startsWith('classify-'));
  const formatLine = (s) =>
    `- \`skills/${s.id}/SKILL.md\`${s.hasTaxonomy ? `（标签词表：\`skills/${s.id}/references/taxonomy.json\`）` : ''}${s.description ? ` — ${s.description}` : ''}`;
  const coreList = coreBigSkills.map(formatLine).join('\n');
  const classifyList = classifySkills.map(formatLine).join('\n');
  return [
    '---',
    'name: kelin-question-bank-export',
    'description: 使用外部 AI 工具按可林留学建库与学科分类规范整理试题，并导出可直接导入可林小程序服务器的标准题库 ZIP 包。',
    '---',
    '',
    '# 可林留学题库分类与 ZIP 导出规范',
    '',
    '本压缩包用于配合外部 AI Agent（如 Claude Code、Codex、Cursor、Antigravity 等）完成本地试题拆题、切图、审图、知识点分类，并生成**可直接上传至可林小程序「题库管理 → 添加题 → ZIP 导入」**的标准题库包。',
    '',
    '## 一、内附大 Skill 与学科分类规范',
    '',
    '### 1. 核心建库与审图大 Skill（含完整 `scripts/` 与 `references/`）',
    '',
    coreList || '- （无）',
    '',
    '### 2. 各学科分类 Skill（含官方 `taxonomy.json`）',
    '',
    classifyList || '- （无）',
    '',
    '## 二、ZIP 压缩包结构合同',
    '',
    '1. 压缩包内**有且只能有一个** `items.json`（推荐路径 `metadata/items.json` 或根目录 `items.json`）。',
    '2. 每次导入最多 **1000 道题目**，解压后总大小不超过 **200 MB**，总文件数不超过 **5000 个**。',
    '3. 禁止绝对路径、软链接或 `..` 跨出压缩包目录。',
    '4. 所有媒体路径（`image`、`gallery[].path`、`audio[]`）必须为**相对于 `items.json` 所在目录**的 POSIX 相对路径，且每个引用的文件都必须真实存在于压缩包内。',
    '   - 例如 `metadata/items.json` 中引用 `"../images/q01.png"`，对应压缩包内文件 `images/q01.png`。',
    '   - 或者根目录 `items.json` 中引用 `"images/q01.png"`，对应压缩包内文件 `images/q01.png`。',
    '5. 题库导入后立即生效，无草稿、审核或发布流程。',
    '',
    '## 三、items.json 字段规范',
    '',
    '`items.json` 可以是题目对象数组 `[...]`，或包含 `items` 数组的对象 `{"items": [...]}`。参考样例见 `references/items-example.json`。',
    '',
    '| 字段 | 必填 | 类型 | 说明 |',
    '| --- | --- | --- | --- |',
    '| `id` | 是 | string (≤191) | 题目在当前 `collection` 内的唯一编号，如 `9709-12-2024-MJ-Q01` |',
    '| `subject` | 是 | string (≤100) | 英文学科代码，如 `mathematics`、`physics`、`chemistry`、`biology`、`economics`、`computer-science`、`further-mathematics`、`chinese`、`ielts` |',
    '| `subject_label` | 建议 | string | 学科中文显示名，如 `数学` |',
    '| `collection` | 是 | string (≤93) | 数据集编号，如 `9709-mathematics`、`ielts-academic` |',
    '| `collection_label` | 建议 | string | 数据集显示名，如 `Cambridge 9709 数学` |',
    '| `title` | 是 | string (≤1000) | 题目标题 |',
    '| `tags` | 是 | string[] | 知识点标签编号数组（来自对应学科 `taxonomy.json`） |',
    '| `tag_names` | 建议 | Record<string, string> | 标签编号到中文/规范名称的映射 |',
    '| `primary_tag` | 建议 | string | 主标签编号（必须存在于 `tags` 中） |',
    '| `primary_tag_name` | 建议 | string | 主标签名称 |',
    '| `question_text` | 建议 | string | 题干纯文本（支持检索） |',
    '| `answer_text` | 建议 | string | 参考答案或解析文本 |',
    '| `image` | 可选 | string \\| null | 主题目图片相对路径 |',
    '| `gallery` | 是 | Array<{kind, path, label}> | 媒体列表；无媒体时传 `[]`。`kind` 常用值：`question`（题图）、`answer`（答案）、`ms`（评分标准）、`sm`（参考解答）、`source`（附件） |',
    '| `audio` | 是 | string[] | 音频相对路径数组；无音频时传 `[]` |',
    '',
    '## 四、分类与打包检查清单',
    '',
    '- 每道完整大题对应一条记录，不拆 `(a)(b)(i)(ii)` 子问。',
    '- 同 `collection` 内 `id` 不能重复。',
    '- `primary_tag` 必须包含在 `tags` 列表中，且与对应学科 `taxonomy.json` 一致。',
    '- 打包后确认只有一份 `items.json`，且所有 `gallery[].path` / `image` / `audio[]` 均可解析到包内真实文件。',
  ].join('\n');
}

function exportItemsExample() {
  return [
    {
      id: '9709-12-2024-MJ-Q01',
      subject: 'mathematics',
      subject_label: '数学',
      collection: '9709-mathematics',
      collection_label: 'Cambridge 9709 数学',
      title: '9709 2024 MJ Paper 12 · Q01 Quadratics',
      tags: ['1.1'],
      tag_names: { '1.1': 'Quadratics' },
      primary_tag: '1.1',
      primary_tag_name: 'Quadratics',
      question_text: 'Find the set of values of k for which the equation x^2 + kx + 9 = 0 has two distinct real roots.',
      answer_text: 'Discriminant k^2 - 36 > 0, so k < -6 or k > 6.',
      image: null,
      gallery: [],
      audio: [],
    },
  ];
}

function appendDirectoryFiltered(archive, srcDir, zipPrefix) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name === '.DS_Store' || entry.name.endsWith('.pyc')) continue;
    const fullPath = path.join(srcDir, entry.name);
    const zipPath = `${zipPrefix}/${entry.name}`;
    if (entry.isDirectory()) appendDirectoryFiltered(archive, fullPath, zipPath);
    else if (entry.isFile()) archive.file(fullPath, { name: zipPath });
  }
}

async function buildSkillBundleBuffer() {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(output);

  archive.append(exportSkillMarkdown(), { name: 'kelin-question-bank-export/SKILL.md' });
  archive.append(JSON.stringify(exportItemsExample(), null, 2), {
    name: 'kelin-question-bank-export/references/items-example.json',
  });

  if (fs.existsSync(SKILLS_ROOT)) {
    const readmePath = path.join(SKILLS_ROOT, 'README.md');
    if (fs.existsSync(readmePath)) {
      archive.file(readmePath, { name: 'kelin-question-bank-export/skills/README.md' });
    }
    for (const skill of listSkills()) {
      const skillDir = path.join(SKILLS_ROOT, skill.id);
      appendDirectoryFiltered(archive, skillDir, `kelin-question-bank-export/skills/${skill.id}`);
    }
  }

  await archive.finalize();
  return finished;
}

module.exports = {
  listSkills,
  readSkill,
  catalogPrompt,
  exportItemsExample,
  buildSkillBundleBuffer,
};
