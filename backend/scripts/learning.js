require('dotenv').config();
const fs = require('node:fs/promises'),
  path = require('node:path');
const c = require('../src/learning/core'),
  questions = require('../src/learning/questions');
const args = process.argv.slice(2),
  command = args.shift();
function option(name, fallback) {
  const i = args.indexOf('--' + name);
  return i < 0 ? fallback : args[i + 1];
}
async function migrate() {
  await c.rows(
    'CREATE TABLE IF NOT EXISTS kl_migrations(name VARCHAR(191) PRIMARY KEY,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)',
  );
  const directory = path.resolve(__dirname, '../../database/migrations');
  for (const name of (await fs.readdir(directory))
    .filter((x) => /^\d+.*\.sql$/.test(x))
    .sort()) {
    if (await c.one('SELECT name FROM kl_migrations WHERE name=?', [name]))
      continue;
    const sql = await fs.readFile(path.join(directory, name), 'utf8');
    for (const statement of sql
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean))
      await c.rows(statement);
    await c.rows('INSERT INTO kl_migrations(name) VALUES(?)', [name]);
    console.log('Applied ' + name);
  }
}
async function sample(source, out) {
  const base = path.join(source, 'question_bank_database_v1'),
    input = await fs.readFile(path.join(base, 'metadata/items.json'), 'utf8'),
    items = JSON.parse(input);
  questions.validate(items);
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id)),
    selected = new Map();
  const add = (x) => {
    if (x) selected.set(x.collection + ':' + x.id, x);
  };
  for (const collection of [...new Set(items.map((x) => x.collection))])
    sorted
      .filter((x) => x.collection === collection)
      .slice(0, 3)
      .forEach(add);
  for (const kind of [
    ...new Set(items.flatMap((x) => x.gallery.map((g) => g.kind))),
  ])
    add(sorted.find((x) => x.gallery.some((g) => g.kind === kind)));
  for (const quality of [...new Set(items.map((x) => x.quality_status))])
    add(sorted.find((x) => x.quality_status === quality));
  for (const predicate of [
    (x) => x.audio.length > 1,
    (x) => x.gallery.length > 3,
    (x) => x.review_required,
    (x) => x.question_range?.end > x.question_range?.start,
    (x) => !x.gallery.some((g) => ['answer', 'ms', 'sm'].includes(g.kind)),
  ])
    add(sorted.find(predicate));
  await fs.mkdir(path.join(out, 'media'), { recursive: true });
  if (
    await fs
      .stat(path.join(out, 'items.json'))
      .then(() => true)
      .catch(() => false)
  )
    throw new Error('样本目录已冻结，请选择新的 --out');
  const manifest = {
      sourceMetadataHash: c.hash(input),
      selectedIds: [],
      media: [],
      createdAt: new Date().toISOString(),
    },
    output = [];
  for (const original of selected.values()) {
    const item = structuredClone(original);
    manifest.selectedIds.push(item.id);
    const refs = [
        ...(item.image ? [item.image] : []),
        ...item.gallery.map((g) => g.path),
        ...item.audio,
      ],
      mapping = new Map();
    for (const ref of new Set(refs)) {
      const file = path.resolve(base, ref),
        root = await fs.realpath(source);
      if (!file.startsWith(root + path.sep)) throw new Error('源媒体越界');
      let bytes;
      try {
        const real = await fs.realpath(file);
        if (!real.startsWith(root + path.sep))
          throw new Error('源媒体软链接越界');
        bytes = await fs.readFile(real);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        mapping.set(ref, 'media/missing-' + c.hash(ref) + path.extname(ref));
        manifest.media.push({ source: ref, missing: true });
        continue;
      }
      const hash = c.hash(bytes),
        relative = 'media/' + hash + path.extname(ref);
      await fs.writeFile(path.join(out, relative), bytes);
      mapping.set(ref, relative);
      manifest.media.push({
        source: ref,
        path: relative,
        hash,
        bytes: bytes.length,
      });
    }
    if (item.image) item.image = mapping.get(item.image);
    item.gallery = item.gallery.map((g) => ({
      ...g,
      path: mapping.get(g.path),
    }));
    item.audio = item.audio.map((p) => mapping.get(p));
    output.push(item);
  }
  await fs.writeFile(path.join(out, 'items.json'), JSON.stringify(output));
  await fs.writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  console.log(
    JSON.stringify({
      directory: out,
      items: output.length,
      collections: new Set(output.map((x) => x.collection)).size,
      media: manifest.media.length,
    }),
  );
}
async function main() {
  if (command === 'migrate') return migrate();
  if (command === 'sample') {
    const source = option('source');
    if (!source) throw new Error('需要 --source 指向 Alevel/output');
    return sample(
      path.resolve(source),
      path.resolve(option('out', 'sample-data')),
    );
  }
  if (command === 'import') {
    const source = path.resolve(option('source', 'sample-data')),
      canonical = await fs
        .stat(path.join(source, 'items.json'))
        .then(() => true)
        .catch(() => false);
    const base = canonical
      ? source
      : path.join(source, 'question_bank_database_v1');
    const items = JSON.parse(
      await fs.readFile(
        path.join(base, canonical ? 'items.json' : 'metadata/items.json'),
        'utf8',
      ),
    );
    let manifest = {};
    try {
      manifest = JSON.parse(
        await fs.readFile(
          path.join(
            source,
            canonical ? 'manifest.json' : 'question_bank_manifest.json',
          ),
          'utf8',
        ),
      );
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return console.log(
      JSON.stringify(
        await questions.importQuestions({
          items,
          baseDirectory: base,
          allowedRoot: source,
          dryRun: args.includes('--dry-run'),
          manifest,
        }),
        null,
        2,
      ),
    );
  }
  if (command === 'grant-admin') {
    const userId = option('user-id');
    if (!/^\d+$/.test(userId || '')) throw new Error('需要显式 --user-id');
    if (!(await c.one('SELECT id FROM users WHERE id=?', [userId])))
      throw new Error('账号不存在');
    await c.rows(
      "INSERT IGNORE INTO kl_capabilities VALUES(?,'platform_admin')",
      [userId],
    );
    console.log('Granted platform_admin to user ' + userId);
    return;
  }
  throw new Error(
    '命令: migrate | sample --source OUTPUT --out DIRECTORY | import --source DIRECTORY [--dry-run] | grant-admin --user-id ID',
  );
}
if (require.main === module)
  main()
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => c.pool.end());
