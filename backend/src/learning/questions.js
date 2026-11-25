const fs = require('node:fs/promises');
const path = require('node:path');
const c = require('./core');
const media = require('./media');
function validate(items) {
  if (!Array.isArray(items) || !items.length) c.fail(400, '题库必须为非空数组');
  const ids = new Set();
  for (const x of items) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) c.fail(400, '题目条目必须为对象');
    for (const field of ['id', 'subject', 'collection', 'title'])
      if (typeof x[field] !== 'string' || !x[field].trim())
        c.fail(400, `条目缺少 ${field}`);
    const key = `${x.collection}:${x.id}`;
    if (ids.has(key)) c.fail(400, `重复来源 ID: ${key}`);
    ids.add(key);
    if (
      !Array.isArray(x.tags) ||
      x.tags.some((t) => typeof t !== 'string') ||
      !Array.isArray(x.gallery) ||
      !Array.isArray(x.audio)
    )
      c.fail(400, `条目数组字段无效: ${key}`);
    if (
      x.gallery.some(
        (g) => !g || typeof g.path !== 'string' || typeof g.kind !== 'string',
      ) ||
      x.audio.some((p) => typeof p !== 'string')
    )
      c.fail(400, `媒体字段无效: ${key}`);
  }
}
function preparedHash(item, assets) {
  return c.hash(JSON.stringify({ item, media: assets.map(a => [a.kind, a.path, a.digest]) }));
}
async function prepare(items, baseDirectory, allowedRoot, validateEntry) {
  validate(items);
  if (validateEntry) items.forEach(validateEntry);
  const root = await fs.realpath(allowedRoot);
  const prepared = [];
  for (const item of items) {
    const refs = [
      ...item.gallery,
      ...item.audio.map((p) => ({
        kind: 'audio',
        label: path.basename(p),
        path: p,
      })),
    ];
    if (item.image && !refs.some((r) => r.path === item.image))
      refs.unshift({ kind: 'question', label: '题目', path: item.image });
    const assets = [];
    for (const ref of refs) {
      let bytes = null;
      const source = path.resolve(baseDirectory, ref.path);
      if (!source.startsWith(root + path.sep))
        c.fail(400, `媒体超出允许目录: ${ref.path}`);
      try {
        const real = await fs.realpath(source);
        if (!real.startsWith(root + path.sep))
          c.fail(400, '媒体软链接超出允许目录');
        bytes = await fs.readFile(real);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      assets.push({ ...ref, bytes, digest: bytes ? c.hash(bytes) : null });
    }
    prepared.push({
      item,
      assets,
      hash: preparedHash(item, assets),
    });
  }
  return prepared;
}
async function importQuestions({ items, baseDirectory, allowedRoot, ...options }) {
  return storePrepared(await prepare(items, baseDirectory, allowedRoot), options);
}
async function storePrepared(prepared, { dryRun = false, manifest = {}, expectedResources = null, importId = null } = {}) {
  let report = {
    items: prepared.length,
    created: 0,
    revisions: 0,
    unchanged: 0,
    missingMedia: prepared.flatMap((x) =>
      x.assets
        .filter((a) => !a.bytes)
        .map((a) => ({ id: x.item.id, path: a.path })),
    ),
    manifest,
    manifestHash: c.hash(
      JSON.stringify(
        prepared.map((x) => [x.item.collection, x.item.id, x.hash]),
      ),
    ),
  };
  if (dryRun) return report;
  // Copy immutable blobs before opening the database transaction; pointers change only after all inserts succeed.
  for (const p of prepared)
    for (const asset of p.assets)
      asset.stored = asset.bytes
        ? await media.blob(asset.bytes, path.extname(asset.path))
        : null;
  await c.transaction(async (db) => {
    if (importId) {
      const inserted = await c.rows('INSERT IGNORE INTO kl_imports(id,manifest_hash,report) VALUES(?,?,?)', [importId, report.manifestHash, '{}'], db);
      if (!inserted.affectedRows) {
        report = c.json((await c.one('SELECT report FROM kl_imports WHERE id=?', [importId], db)).report);
        return;
      }
    }
    for (const { item, assets, hash } of prepared) {
      let resource = await c.one(
        'SELECT * FROM kl_resources WHERE namespace=? AND source_id=? FOR UPDATE',
        ['alevel:' + item.collection, item.id],
        db,
      );
      if (expectedResources) {
        const key = item.collection + ':' + item.id;
        const expected = expectedResources[key];
        if (!Object.hasOwn(expectedResources, key) || (expected === null ? Boolean(resource) : !resource || resource.current_revision !== expected.revisionId || resource.visibility !== expected.visibility))
          c.fail(409, '题目已更新，请重新打开编辑或重新预览导入：' + item.id);
      }
      if (!resource) {
        resource = { id: c.id() };
        await c.rows(
          'INSERT INTO kl_resources(id,namespace,source_id,type) VALUES(?,?,?,?)',
          [resource.id, 'alevel:' + item.collection, item.id, 'question'],
          db,
        );
        report.created++;
      }
      let revision = await c.one(
        'SELECT id FROM kl_revisions WHERE resource_id=? AND content_hash=?',
        [resource.id, hash],
        db,
      );
      if (!revision) {
        revision = { id: c.id() };
        await c.rows(
          'INSERT INTO kl_revisions(id,resource_id,content_hash,data,subject,collection_code,skill,quality_status,release_status,review_required,search_text) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          [
            revision.id,
            resource.id,
            hash,
            JSON.stringify(item),
            item.subject,
            item.collection,
            item.skill || '',
            item.quality_status || '',
            item.release_status || '',
            Boolean(item.review_required),
            item.search_text ||
              `${item.id} ${item.title} ${item.primary_tag_name || ''}`,
          ],
          db,
        );
        for (const tag of [...new Set(item.tags)])
          await c.rows(
            'INSERT INTO kl_tags VALUES(?,?,?,?)',
            [revision.id, item.collection, tag, item.tag_names && Object.hasOwn(item.tag_names, tag) ? item.tag_names[tag] || tag : tag],
            db,
          );
        for (const [position, a] of assets.entries())
          await c.rows(
            'INSERT INTO kl_media(id,revision_id,kind,position,label,storage_path,mime,original_path,content_hash) VALUES(?,?,?,?,?,?,?,?,?)',
            [
              c.id(),
              revision.id,
              a.kind,
              position,
              a.label || a.kind,
              a.stored?.path || null,
              media.mime(a.path),
              a.path,
              a.digest,
            ],
            db,
          );
        report.revisions++;
      } else report.unchanged++;
      await c.rows(
        'UPDATE kl_resources SET current_revision=? WHERE id=?',
        [revision.id, resource.id],
        db,
      );
    }
    if (importId) await c.rows('UPDATE kl_imports SET report=? WHERE id=?', [JSON.stringify(report), importId], db);
    else await c.rows('INSERT INTO kl_imports(id,manifest_hash,report) VALUES(?,?,?)', [c.id(), report.manifestHash, JSON.stringify(report)], db);
  });
  return report;
}
function addSearchFilters(query, where, args) {
  for (const [key, column] of [['subject', 'subject'], ['collection', 'collection_code']]) {
    if (query[key]) {
      where.push('v.' + column + '=?');
      args.push(String(query[key]));
    }
  }
  if (query.q) {
    where.push('v.search_text LIKE ?');
    args.push(c.containsPattern(query.q));
  }
}
function conditions(q) {
  const where = ['r.type=?', "r.visibility='public'", "v.status='ready'"];
  const args = ['question'];
  where.push("v.release_status<>'draft'");
  addSearchFilters(q, where, args);
  for (const [field, column] of Object.entries({
    skill: 'skill',
    qualityStatus: 'quality_status',
    releaseStatus: 'release_status',
  }))
    if (q[field]) {
      where.push(`v.${column}=?`);
      args.push(String(q[field]));
    }
  if (q.reviewRequired !== undefined && q.reviewRequired !== '') {
    where.push('v.review_required=?');
    args.push(q.reviewRequired === true || q.reviewRequired === 'true');
  }
  if (q.tag) {
    if (!q.collection) c.fail(400, '标签筛选必须指定数据集');
    where.push(
      'EXISTS(SELECT 1 FROM kl_tags t WHERE t.revision_id=v.id AND t.collection_code=? AND t.code=?)',
    );
    args.push(String(q.collection), String(q.tag));
  }
  return { sql: where.join(' AND '), args };
}
async function list(q = {}) {
  const p = c.page(q),
    w = conditions(q);
  const from =
    'FROM kl_resources r JOIN kl_revisions v ON v.id=r.current_revision WHERE ' +
    w.sql;
  const total = await c.one('SELECT COUNT(*) total ' + from, w.args);
  const found = await c.rows(
    'SELECT r.id resourceId,r.source_id sourceId,v.id revisionId,v.content_hash contentHash,v.data ' +
      from +
      ' ORDER BY r.source_id,r.id' + c.limitOffset(p),
    w.args,
  );
  return {
    items: found.map((x) => ({
      ...c.json(x.data),
      resourceId: x.resourceId,
      sourceId: x.sourceId,
      revisionId: x.revisionId,
      contentHash: x.contentHash,
    })),
    total: Number(total.total),
    page: p.page,
    pageSize: p.pageSize,
  };
}
async function detail(user, resourceId, revisionId, sessionHash) {
  const resource = await media.requireResource(user, resourceId);
  const revision = await c.one(
    'SELECT * FROM kl_revisions WHERE id=? AND resource_id=?',
    [revisionId || resource.current_revision, resourceId],
  );
  if (!revision) c.fail(404, '资料修订不存在');
  await media.requirePublishedQuestion(user, resource, revision.release_status);
  return {
    ...c.json(revision.data),
    ownerId: resource.owner_id,
    visibility: resource.visibility,
    type: resource.type,
    resourceId,
    sourceId: resource.source_id,
    revisionId: revision.id,
    contentHash: revision.content_hash,
    status: revision.status,
    media: sessionHash ? await media.references(revision.id, sessionHash) : [],
    chunks: await c.rows(
      'SELECT position,label,body FROM kl_chunks WHERE revision_id=? ORDER BY position',
      [revision.id],
    ),
  };
}
async function facets(q = {}) {
  const w = conditions(q);
  const found = await c.rows(
    `SELECT v.subject,v.collection_code collection,v.skill,MAX(JSON_UNQUOTE(JSON_EXTRACT(v.data,'$.subject_label'))) subjectLabel,MAX(JSON_UNQUOTE(JSON_EXTRACT(v.data,'$.collection_label'))) collectionLabel,MAX(JSON_UNQUOTE(JSON_EXTRACT(v.data,'$.skill_label'))) skillLabel,COUNT(*) count FROM kl_resources r JOIN kl_revisions v ON v.id=r.current_revision WHERE ` +
      w.sql +
      ' GROUP BY v.subject,v.collection_code,v.skill',
    w.args,
  );
  return found.map((x) => ({ ...x, count: Number(x.count) }));
}
async function taxonomy(collection) {
  if (!collection) c.fail(400, '需要数据集');
  return c.rows(
    "SELECT t.code,MAX(t.label) label,COUNT(*) count FROM kl_tags t JOIN kl_resources r ON r.current_revision=t.revision_id JOIN kl_revisions v ON v.id=t.revision_id WHERE t.collection_code=? AND r.type='question' AND r.visibility='public' AND v.status='ready' AND v.release_status<>'draft' GROUP BY t.code ORDER BY t.code",
    [collection],
  );
}
module.exports = {
  validate,
  preparedHash,
  addSearchFilters,
  prepare,
  importQuestions,
  storePrepared,
  list,
  detail,
  facets,
  taxonomy,
};
