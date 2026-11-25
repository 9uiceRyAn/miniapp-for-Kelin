// 管理题库修订、媒体上传和先预览后确认的 JSON/ZIP 导入。
const fs = require('node:fs/promises');
const path = require('node:path');
const signatures = require('./signatures');
const yauzl = require('yauzl');
const c = require('./core');
const q = require('./questions');
const media = require('./media');
const STAGING = path.join(media.ROOT, 'question-imports');
const MAX_ITEMS = 1000;
const MAX_EXPANDED = 200 * 1024 * 1024;
const STATES = ['draft', 'published', 'provisional'];
const KINDS = ['question', 'answer', 'ms', 'sm', 'audio', 'source'];

/** Sign an expiring upload/import reference for the current administrator. */
function sign(user, purpose, data) {
  const payload = Buffer.from(JSON.stringify({ ...data, userId: String(user.id), purpose, expires: Date.now() + 86400000 })).toString('base64url');
  return payload + '.' + signatures.signature(payload);
}
function verify(user, purpose, token) {
  const [payload, signature = ''] = String(token || '').split('.');
  if (!signatures.matches(payload || '', signature)) c.fail(400, '上传或导入凭证无效，请重新选择文件');
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { c.fail(400, '上传或导入凭证无效'); }
  if (data.userId !== String(user.id) || data.purpose !== purpose) c.fail(403, '无权使用此上传文件');
  if (data.expires < Date.now()) c.fail(410, '上传或导入预览已过期，请重新选择文件');
  return data;
}
function text(value, name, max = 500, required = false) {
  if (value !== undefined && typeof value !== 'string') c.fail(400, name + '必须为文字');
  const result = (value || '').trim();
  if (result.length > max || (required && !result)) c.fail(400, name + '不能为空或超过 ' + max + ' 字符');
  return result;
}
function validateItem(item) {
  for (const [key, max] of [['id', 191], ['subject', 100], ['collection', 93], ['title', 1000]]) text(item[key], key, max, true);
  if (!STATES.includes(item.release_status || 'published')) c.fail(400, '发布状态无效');
  if (item.review_required !== undefined && typeof item.review_required !== 'boolean') c.fail(400, '待审核标记无效');
  if (item.tags.length > 100 || item.tags.some(tag => !tag.trim() || tag.length > 100)) c.fail(400, '标签编号不能为空或超过 100 字符');
  if (item.tag_names && (typeof item.tag_names !== 'object' || Array.isArray(item.tag_names))) c.fail(400, '标签名称无效');
  for (const label of Object.values(item.tag_names || {})) text(label, '标签名称', 191);
  for (const [key, max] of [['skill', 100], ['quality_status', 100], ['primary_tag', 100], ['question_text', 100000], ['answer_text', 100000], ['search_text', 1000000]]) if (item[key] !== undefined) text(item[key], key, max);
  if (item.image !== undefined && item.image !== null) text(item.image, '题目图片路径', 1000);
  for (const entry of item.gallery) {
    text(entry.kind, '媒体类型', 32, true);
    text(entry.path, '媒体路径', 1000, true);
    text(entry.label, '媒体标题', 191);
  }
  return item;
}
function searchable(item) {
  return [item.id, item.title, item.subject_label, item.collection_label, item.primary_tag_name, ...Object.values(item.tag_names || {}), item.question_text, item.answer_text].filter(Boolean).join(' ');
}

async function upload(user, bytes, name) {
  const extension = path.extname(name).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.pdf', '.mp3', '.m4a'].includes(extension)) c.fail(400, '支持 PNG、JPG、WebP、PDF 和音频文件');
  if (!bytes?.length) c.fail(400, '文件为空');
  const stored = await media.blob(bytes, extension);
  return { token: sign(user, 'attachment', { path: stored.path, name: path.basename(name), digest: stored.hash }), name: path.basename(name), mime: media.mime(name) };
}
async function ownedQuestion(id, db = c.pool) {
  const resource = await c.one("SELECT * FROM kl_resources WHERE id=? AND type='question'" + (db === c.pool ? '' : ' FOR UPDATE'), [id], db);
  if (!resource) c.fail(404, '题目不存在');
  return resource;
}
async function detail(id, sessionHash) {
  const resource = await ownedQuestion(id);
  const revision = await c.one('SELECT * FROM kl_revisions WHERE id=? AND resource_id=?', [resource.current_revision, id]);
  const attachments = await media.references(revision.id, resource.visibility === 'withdrawn' ? null : sessionHash);
  return { ...c.json(revision.data), resourceId: id, revisionId: revision.id, visibility: resource.visibility,
    attachments };
}
async function list(query) {
  const where = ["r.type='question'", "v.status='ready'"];
  const args = [];
  if (query.state === 'deleted') where.push("r.visibility='withdrawn'");
  else {
    where.push("r.visibility='public'");
    if (query.state && query.state !== 'all') {
      if (!STATES.includes(query.state)) c.fail(400, '发布状态筛选无效');
      if (query.state === 'published') where.push("v.release_status IN ('published','')");
      else { where.push('v.release_status=?'); args.push(query.state); }
    }
  }
  q.addSearchFilters(query, where, args);
  if (query.reviewRequired === 'true') where.push('v.review_required=1');
  const from = ' FROM kl_resources r JOIN kl_revisions v ON v.id=r.current_revision WHERE ' + where.join(' AND ');
  const p = c.page(query);
  const total = await c.one('SELECT COUNT(*) total' + from, args);
  const found = await c.rows('SELECT r.id resourceId,r.source_id sourceId,r.visibility,v.id revisionId,v.data' + from + ' ORDER BY r.created_at DESC,r.id' + c.limitOffset(p), args);
  const items = [];
  for (const row of found) {
    const data = c.json(row.data);
    const refs = row.visibility !== 'withdrawn' && query.sessionHash ? await media.references(row.revisionId, query.sessionHash) : [];
    items.push({ resourceId: row.resourceId, revisionId: row.revisionId, sourceId: row.sourceId, visibility: row.visibility, title: data.title, subject: data.subject, subject_label: data.subject_label || data.subject, collection: data.collection, collection_label: data.collection_label || data.collection, primary_tag_name: data.primary_tag_name || '', release_status: data.release_status || 'published', review_required: Boolean(data.review_required), thumbnail: refs.find(m => m.kind === 'question' && m.mime.startsWith('image/') && m.available) || null });
  }
  return { items, total: Number(total.total), page: p.page, pageSize: p.pageSize };
}
async function facets() {
  return c.rows("SELECT v.subject,v.collection_code collection,MAX(JSON_UNQUOTE(JSON_EXTRACT(v.data,'$.subject_label'))) subjectLabel,MAX(JSON_UNQUOTE(JSON_EXTRACT(v.data,'$.collection_label'))) collectionLabel,COUNT(*) count FROM kl_resources r JOIN kl_revisions v ON v.id=r.current_revision WHERE r.type='question' GROUP BY v.subject,v.collection_code ORDER BY v.subject,v.collection_code");
}

/** Save a new immutable revision, checking the head the editor actually opened. */
async function save(user, id, input) {
  let previous = null, resource = null, oldAssets = [];
  if (id) {
    resource = await ownedQuestion(id);
    if (resource.visibility === 'withdrawn') c.fail(409, '请先恢复已删除的题目');
    if (!input.expectedRevisionId || input.expectedRevisionId !== resource.current_revision) c.fail(409, '题目已更新，请重新打开后编辑');
    previous = c.json((await c.one('SELECT data FROM kl_revisions WHERE id=?', [resource.current_revision])).data);
    oldAssets = await c.rows('SELECT * FROM kl_media WHERE revision_id=? ORDER BY position,id', [resource.current_revision]);
  }
  const item = { ...(previous || {}), id: previous?.id || text(input.sourceId, '来源编号', 191) || 'manual-' + c.id(),
    subject: previous?.subject || text(input.subject, '学科编号', 100, true), collection: previous?.collection || text(input.collection, '数据集编号', 93, true),
    title: text(input.title === undefined ? previous?.title : input.title, '题目标题', 1000, true),
    subject_label: previous?.subject_label || text(input.subjectLabel, '学科名称', 191) || input.subject,
    collection_label: previous?.collection_label || text(input.collectionLabel, '数据集名称', 191) || input.collection,
    question_text: text(input.questionText === undefined ? previous?.question_text || '' : input.questionText, '题干', 100000),
    answer_text: text(input.answerText === undefined ? previous?.answer_text || '' : input.answerText, '答案', 100000),
    tags: input.tags === undefined ? previous?.tags || [] : input.tags,
    tag_names: input.tagNames === undefined ? previous?.tag_names || {} : input.tagNames,
    release_status: input.releaseStatus === undefined ? previous ? previous.release_status || 'published' : 'draft' : input.releaseStatus,
    review_required: input.reviewRequired === undefined ? previous ? Boolean(previous.review_required) : true : input.reviewRequired };
  if (!Array.isArray(item.tags) || !item.tag_names || typeof item.tag_names !== 'object' || Array.isArray(item.tag_names)) c.fail(400, '知识点标签无效');
  item.primary_tag = previous?.primary_tag && item.tags.includes(previous.primary_tag) ? previous.primary_tag : item.tags[0] || '';
  item.primary_tag_name = Object.hasOwn(item.tag_names, item.primary_tag) ? item.tag_names[item.primary_tag] : item.primary_tag;
  const assets = [];
  const requested = input.attachments === undefined ? oldAssets.map(a => ({ id: a.id, kind: a.kind, label: a.label })) : input.attachments;
  if (!Array.isArray(requested) || requested.length > 100) c.fail(400, '每题最多添加 100 个媒体文件');
  for (const entry of requested) {
    if (!entry || typeof entry !== 'object') c.fail(400, '媒体类型无效');
    if (entry.id) {
      const old = oldAssets.find(a => a.id === entry.id);
      if (!old) c.fail(400, '媒体不属于当前题目修订');
      if (entry.kind !== old.kind && !KINDS.includes(entry.kind)) c.fail(400, '媒体类型无效');
      const bytes = old.storage_path ? await fs.readFile(media.absolute(old.storage_path)) : null;
      assets.push({ kind: entry.kind, label: text(entry.label, '媒体标题', 191) || old.label, path: old.original_path, bytes, digest: old.content_hash });
    } else {
      if (!KINDS.includes(entry.kind)) c.fail(400, '媒体类型无效');
      const staged = verify(user, 'attachment', entry.token);
      const bytes = await fs.readFile(media.absolute(staged.path));
      if (c.hash(bytes) !== staged.digest) c.fail(409, '上传文件已发生变化');
      assets.push({ kind: entry.kind, label: text(entry.label, '媒体标题', 191) || staged.name, path: 'uploads/' + staged.digest + path.extname(staged.name).toLowerCase(), bytes, digest: staged.digest });
    }
  }
  if (!item.question_text && !assets.some(a => a.kind === 'question' && a.bytes) && (!previous || previous.question_text || oldAssets.some(a => a.kind === 'question' && a.storage_path))) c.fail(400, '请填写题干或上传题目图片／PDF');
  item.gallery = assets.filter(a => a.kind !== 'audio').map(a => ({ kind: a.kind, label: a.label, path: a.path }));
  item.audio = assets.filter(a => a.kind === 'audio').map(a => a.path);
  item.image = assets.find(a => a.kind === 'question' && media.mime(a.path).startsWith('image/'))?.path || null;
  item.search_text = searchable(item);
  q.validate([item]);
  validateItem(item);
  const key = item.collection + ':' + item.id;
  await q.storePrepared([{ item, assets, hash: q.preparedHash(item, assets) }], {
    manifest: { source: 'question-management', actorId: user.id, action: id ? 'edit' : 'create' },
    expectedResources: { [key]: resource ? { revisionId: resource.current_revision, visibility: resource.visibility } : null },
  });
  const saved = await c.one('SELECT id FROM kl_resources WHERE namespace=? AND source_id=?', ['alevel:' + item.collection, item.id]);
  return detail(saved.id);
}
async function visibility(user, id, input, deleted) {
  return c.transaction(async db => {
    const resource = await ownedQuestion(id, db);
    if (!input.expectedRevisionId || input.expectedRevisionId !== resource.current_revision) c.fail(409, '题目已更新，请刷新后重试');
    const target = deleted ? 'withdrawn' : 'public';
    if (resource.visibility !== target) {
      await c.rows('UPDATE kl_resources SET visibility=? WHERE id=?', [target, id], db);
      await c.rows('INSERT INTO kl_imports(id,manifest_hash,report) VALUES(?,?,?)', [c.id(), c.hash(id + target), JSON.stringify({ action: deleted ? 'delete' : 'restore', actorId: user.id, resourceId: id, revisionId: resource.current_revision })], db);
    }
    return { resourceId: id, visibility: target };
  });
}

async function extractZip(bytes, directory) {
  const zip = await yauzl.fromBufferPromise(bytes, { lazyEntries: true, validateEntrySizes: true });
  const names = new Set();
  let expanded = 0;
  await new Promise((resolve, reject) => {
    let failed = false;
    const abort = error => { if (!failed) { failed = true; zip.close(); reject(error); } };
    zip.on('error', abort);
    zip.on('end', resolve);
    zip.on('entry', entry => {
      (async () => {
        const name = entry.fileName;
        if (names.size >= 5000 || names.has(name) || name.includes('\0') || name.includes(':') || path.posix.isAbsolute(name) || name.split('/').includes('..')) c.fail(400, 'ZIP 路径重复、越界或文件过多');
        names.add(name);
        if ((entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000) c.fail(400, 'ZIP 不支持软链接');
        expanded += entry.uncompressedSize;
        if (expanded > MAX_EXPANDED) c.fail(413, 'ZIP 解压后不能超过 200 MB');
        const target = path.resolve(directory, name);
        if (!target.startsWith(directory + path.sep)) c.fail(400, 'ZIP 路径越界');
        if (name.endsWith('/')) await fs.mkdir(target, { recursive: true });
        else {
          await fs.mkdir(path.dirname(target), { recursive: true });
          const stream = await zip.openReadStreamPromise(entry);
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          await fs.writeFile(target, Buffer.concat(chunks), { flag: 'wx' });
        }
        if (!failed) zip.readEntry();
      })().catch(abort);
    });
    zip.readEntry();
  });
  const metadata = [...names].filter(name => name === 'items.json' || name.endsWith('/items.json'));
  if (metadata.length !== 1) c.fail(400, 'ZIP 中需要且只能有一个 items.json');
  return path.join(directory, metadata[0]);
}
async function removeImport(directory) {
  await fs.rm(directory, { recursive: true, force: true });
  await fs.rm(directory + '.json', { force: true });
}
function importDirectory(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) c.fail(400, '导入编号无效');
  return path.join(STAGING, id);
}
async function previewImport(user, bytes, name) {
  const id = c.id(), directory = importDirectory(id);
  await fs.mkdir(directory, { recursive: true });
  try {
    let metadata;
    if (path.extname(name).toLowerCase() === '.zip') metadata = await extractZip(bytes, directory);
    else if (path.extname(name).toLowerCase() === '.json') { metadata = path.join(directory, 'items.json'); await fs.writeFile(metadata, bytes); }
    else c.fail(400, '请选择 JSON 题目清单或 ZIP 题库包');
    let parsed;
    try { parsed = JSON.parse(await fs.readFile(metadata, 'utf8')); } catch { c.fail(400, 'items.json 不是有效的 JSON'); }
    const items = Array.isArray(parsed) ? parsed : parsed?.items;
    if (Array.isArray(items) && items.length > MAX_ITEMS) c.fail(400, '每次最多导入 1000 道题目');
    const prepared = await q.prepare(items, path.dirname(metadata), directory, validateItem);
    const missing = prepared.flatMap(p => p.assets.filter(a => !a.bytes).map(a => p.item.id + ': ' + a.path));
    if (missing.length) c.fail(400, '缺少 ' + missing.length + ' 个媒体文件：' + missing.slice(0, 3).join('、'));
    const heads = {}, summary = { items: items.length, created: 0, updated: 0, unchanged: 0, media: prepared.reduce((n, p) => n + p.assets.length, 0),
      published: items.filter(item => !item.release_status || item.release_status === 'published').length,
      drafts: items.filter(item => item.release_status === 'draft').length,
      provisional: items.filter(item => item.release_status === 'provisional').length };
    for (const p of prepared) {
      const existing = await c.one('SELECT * FROM kl_resources WHERE namespace=? AND source_id=?', ['alevel:' + p.item.collection, p.item.id]);
      if (existing?.visibility === 'withdrawn') c.fail(409, '题目 ' + p.item.id + ' 已删除，请先在管理页恢复');
      heads[p.item.collection + ':' + p.item.id] = existing ? { revisionId: existing.current_revision, visibility: existing.visibility } : null;
      if (!existing) summary.created++;
      else {
        const revision = await c.one('SELECT content_hash FROM kl_revisions WHERE id=?', [existing.current_revision]);
        if (revision.content_hash === p.hash) summary.unchanged++; else summary.updated++;
      }
    }
    const state = { metadata: path.relative(directory, metadata), digest: c.hash(bytes), summary, heads };
    await fs.writeFile(directory + '.json', JSON.stringify(state));
    return { token: sign(user, 'import', { id, digest: state.digest }), name, summary,
      samples: items.slice(0, 5).map(item => ({ key: item.collection + ':' + item.id, sourceId: item.id, title: item.title, collection: item.collection })) };
  } catch (error) {
    await removeImport(directory);
    if (!error.status) c.fail(400, '无法读取导入文件：' + error.message);
    throw error;
  }
}
async function confirmImport(user, token) {
  const ref = verify(user, 'import', token);
  const already = await c.one('SELECT report FROM kl_imports WHERE id=?', [ref.id]);
  if (already) return c.json(already.report);
  const directory = importDirectory(ref.id);
  let state;
  try { state = JSON.parse(await fs.readFile(directory + '.json', 'utf8')); } catch { c.fail(410, '导入预览已取消，请重新选择文件'); }
  if (state.digest !== ref.digest) c.fail(409, '导入文件已变化，请重新预览');
  const metadata = path.join(directory, state.metadata);
  const parsed = JSON.parse(await fs.readFile(metadata, 'utf8'));
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  const prepared = await q.prepare(items, path.dirname(metadata), directory, validateItem);
  const report = await q.storePrepared(prepared, { manifest: { source: 'question-management-import', actorId: user.id }, importId: ref.id, expectedResources: state.heads });
  await removeImport(directory);
  return report;
}
async function cancelImport(user, token) {
  const ref = verify(user, 'import', token);
  const directory = importDirectory(ref.id);
  await removeImport(directory);
  return { cancelled: true };
}
module.exports = { upload, list, facets, detail, save, visibility, previewImport, confirmImport, cancelImport };
