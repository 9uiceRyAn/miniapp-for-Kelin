const express = require('express');
const multer = require('multer');
const { ZipArchive } = require('archiver');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { pool } = require('../db');
const { requireAuth, requireTeacher } = require('../middleware/auth');
const { decodeUploadName } = require('../utils/upload-name');
const { UPLOAD_ROOT, storedFilePath } = require('../utils/file-storage');

const router = express.Router();
const TEMP_ROOT = path.join(UPLOAD_ROOT, '.tmp');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);
const AI_INDEX_EXTS = new Set(['.pdf', '.docx', '.txt', '.md', '.png', '.jpg', '.jpeg', '.webp']);

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const upload = multer({
  dest: TEMP_ROOT,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

function safeName(name, fallback = '未命名') {
  const value = String(name || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim();
  return value.slice(0, 180) || fallback;
}

function safeExt(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
}

function makeStoredName(originalName) {
  return `${Date.now()}_${crypto.randomBytes(12).toString('hex')}${safeExt(originalName)}`;
}

function isTeacher(user) {
  return user && user.role === 'teacher';
}

function canMutate(user, ownerId) {
  return isTeacher(user) || String(user?.id) === String(ownerId);
}

async function ensureLegacyFolders() {
  const [existing] = await pool.query('SELECT COUNT(*) total FROM drive_folders WHERE legacy_category IS NOT NULL');
  if (Number(existing[0]?.total || 0) >= 5) return;
  const [teachers] = await pool.query("SELECT id FROM users WHERE role='teacher' AND status=1 ORDER BY id ASC LIMIT 1");
  const ownerId = teachers[0]?.id;
  if (!ownerId) return;
  for (const code of ['A', 'B', 'C', 'D', 'E']) {
    await pool.execute(
      'INSERT IGNORE INTO drive_folders (parent_id, name, owner_id, legacy_category) VALUES (NULL, ?, ?, ?)',
      [`${code} 类资料`, ownerId, code],
    );
  }
  await pool.execute(
    'UPDATE files f JOIN drive_folders d ON d.legacy_category = f.category SET f.folder_id = d.id WHERE f.folder_id IS NULL',
  );
}

async function folderById(id, includeDeleted = false) {
  const [rows] = await pool.execute(
    `SELECT d.*, u.display_name AS owner_name FROM drive_folders d LEFT JOIN users u ON u.id = d.owner_id WHERE d.id = ? ${includeDeleted ? '' : 'AND d.deleted_at IS NULL'} LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function fileById(id, includeDeleted = false) {
  const [rows] = await pool.execute(
    `SELECT f.*, u.display_name AS uploader_name FROM files f LEFT JOIN users u ON u.id = f.uploader_id WHERE f.id = ? ${includeDeleted ? '' : 'AND f.deleted_at IS NULL'} LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function siblingFolderExists(parentId, name, excludeId = null) {
  const [rows] = await pool.execute(
    `SELECT id FROM drive_folders WHERE ${parentId === null ? 'parent_id IS NULL' : 'parent_id = ?'} AND name = ? AND deleted_at IS NULL ${excludeId ? 'AND id <> ?' : ''} LIMIT 1`,
    [...(parentId === null ? [] : [parentId]), name, ...(excludeId ? [excludeId] : [])],
  );
  return Boolean(rows.length);
}

async function breadcrumbs(folderId) {
  const trail = [];
  let current = folderId ? Number(folderId) : null;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const row = await folderById(current);
    if (!row) break;
    trail.unshift({ id: row.id, name: row.name, parent_id: row.parent_id });
    current = row.parent_id;
  }
  return trail;
}

async function collectSubtreeFolderIds(rootId) {
  const [all] = await pool.query('SELECT id, parent_id, owner_id FROM drive_folders WHERE deleted_at IS NULL');
  const childrenMap = new Map();
  for (const row of all) {
    const key = row.parent_id ? String(row.parent_id) : 'root';
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key).push(row);
  }
  const ids = [Number(rootId)];
  const queue = [Number(rootId)];
  while (queue.length) {
    const cur = queue.shift();
    for (const child of childrenMap.get(String(cur)) || []) {
      ids.push(child.id);
      queue.push(child.id);
    }
  }
  return ids;
}

function triggerAiIndex(user, fileRow) {
  const ext = safeExt(fileRow.original_name);
  if (!AI_INDEX_EXTS.has(ext)) return;
  setImmediate(async () => {
    try {
      const docs = require('../learning/documents');
      const indexed = await docs.indexFile(user, fileRow.id, { driveUpload: true });
      await pool.execute(
        "UPDATE files SET ai_resource_id = ?, ai_index_status = ?, ai_index_error = NULL WHERE id = ?",
        [indexed.resourceId, indexed.status === 'ready' ? 'ready' : 'queued', fileRow.id],
      );
    } catch (error) {
      await pool.execute(
        "UPDATE files SET ai_index_status = 'failed', ai_index_error = ? WHERE id = ?",
        [String(error.message || '索引失败').slice(0, 500), fileRow.id],
      ).catch(() => {});
    }
  });
}

function publicFolder(row, user) {
  return {
    id: row.id,
    parent_id: row.parent_id,
    name: row.name,
    owner_id: row.owner_id,
    owner_name: row.owner_name || '',
    legacy_category: row.legacy_category || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    canEdit: canMutate(user, row.owner_id),
  };
}

function publicDriveFile(row, user, markedSet) {
  return {
    id: row.id,
    folder_id: row.folder_id,
    category: row.category,
    original_name: row.original_name,
    file_size: Number(row.file_size || 0),
    mime_type: row.mime_type || '',
    file_type: row.file_type || '',
    uploader_id: row.uploader_id,
    uploader_name: row.uploader_name || '',
    ai_resource_id: row.ai_resource_id || null,
    ai_index_status: row.ai_index_status || 'none',
    created_at: row.created_at,
    updated_at: row.updated_at,
    marked: markedSet ? markedSet.has(Number(row.id)) : false,
    canEdit: canMutate(user, row.uploader_id),
  };
}

router.use(requireAuth);

router.get('/tree', async (req, res, next) => {
  try {
    await ensureLegacyFolders();
    const [rows] = await pool.query(
      'SELECT id, parent_id, name, owner_id, legacy_category FROM drive_folders WHERE deleted_at IS NULL ORDER BY legacy_category IS NULL, legacy_category, name, id',
    );
    res.json({ success: true, data: { folders: rows } });
  } catch (e) { next(e); }
});

router.get('/items', async (req, res, next) => {
  try {
    await ensureLegacyFolders();
    const folderId = req.query.folderId ? Number(req.query.folderId) : null;
    const q = String(req.query.q || '').trim();
    const hideMarked = req.query.hideMarked === 'true';
    const onlyMarked = req.query.onlyMarked === 'true';
    const sort = req.query.sort === 'name' ? 'name' : req.query.sort === 'size' ? 'size' : 'time';

    if (folderId && !(await folderById(folderId))) {
      return res.status(404).json({ success: false, message: '文件夹不存在' });
    }

    const [markRows] = await pool.execute('SELECT file_id FROM user_file_marks WHERE user_id = ?', [req.user.id]);
    const markedSet = new Set(markRows.map(r => Number(r.file_id)));

    let folders = [];
    let files = [];

    if (q) {
      const [fRows] = await pool.execute(
        `SELECT d.*, u.display_name AS owner_name FROM drive_folders d LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.deleted_at IS NULL AND LOCATE(?, d.name) > 0 ORDER BY d.name, d.id LIMIT 100`,
        [q.slice(0, 100)],
      );
      const [fileRows] = await pool.execute(
        `SELECT f.*, u.display_name AS uploader_name FROM files f LEFT JOIN users u ON u.id = f.uploader_id
         WHERE f.deleted_at IS NULL AND LOCATE(?, f.original_name) > 0 ORDER BY f.created_at DESC, f.id DESC LIMIT 200`,
        [q.slice(0, 100)],
      );
      folders = fRows.map(r => publicFolder(r, req.user));
      files = fileRows.map(r => publicDriveFile(r, req.user, markedSet));
    } else {
      const [fRows] = await pool.execute(
        `SELECT d.*, u.display_name AS owner_name FROM drive_folders d LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.deleted_at IS NULL AND ${folderId === null ? 'd.parent_id IS NULL' : 'd.parent_id = ?'}
         ORDER BY d.legacy_category IS NULL, d.legacy_category, ${sort === 'name' ? 'd.name ASC' : 'd.updated_at DESC'}, d.id DESC`,
        folderId === null ? [] : [folderId],
      );
      const orderBy = sort === 'name' ? 'f.original_name ASC' : sort === 'size' ? 'f.file_size DESC' : 'f.created_at DESC';
      const [fileRows] = await pool.execute(
        `SELECT f.*, u.display_name AS uploader_name FROM files f LEFT JOIN users u ON u.id = f.uploader_id
         WHERE f.deleted_at IS NULL AND ${folderId === null ? 'f.folder_id IS NULL' : 'f.folder_id = ?'}
         ORDER BY ${orderBy}, f.id DESC`,
        folderId === null ? [] : [folderId],
      );
      folders = fRows.map(r => publicFolder(r, req.user));
      files = fileRows.map(r => publicDriveFile(r, req.user, markedSet));
    }

    if (hideMarked) files = files.filter(f => !f.marked);
    if (onlyMarked) files = files.filter(f => f.marked);

    const trail = folderId ? await breadcrumbs(folderId) : [];
    res.json({
      success: true,
      data: {
        breadcrumbs: trail,
        folders,
        files,
        markedIds: [...markedSet],
      },
    });
  } catch (e) { next(e); }
});

router.post('/folders', async (req, res, next) => {
  try {
    const parentId = req.body.parentId ? Number(req.body.parentId) : null;
    const name = safeName(req.body.name, '');
    if (!name) return res.status(400).json({ success: false, message: '请输入文件夹名称' });
    if (parentId && !(await folderById(parentId))) {
      return res.status(404).json({ success: false, message: '父文件夹不存在' });
    }
    if (await siblingFolderExists(parentId, name)) {
      return res.status(409).json({ success: false, message: '当前目录下已存在同名文件夹' });
    }
    const [result] = await pool.execute(
      'INSERT INTO drive_folders (parent_id, name, owner_id) VALUES (?, ?, ?)',
      [parentId, name, req.user.id],
    );
    const created = await folderById(result.insertId);
    res.status(201).json({ success: true, data: publicFolder(created, req.user) });
  } catch (e) { next(e); }
});

router.patch('/folders/:id', async (req, res, next) => {
  try {
    const folder = await folderById(req.params.id);
    if (!folder) return res.status(404).json({ success: false, message: '文件夹不存在' });
    if (!canMutate(req.user, folder.owner_id)) {
      return res.status(403).json({ success: false, message: '只能修改自己创建的文件夹' });
    }
    const nextName = req.body.name !== undefined ? safeName(req.body.name, '') : folder.name;
    if (!nextName) return res.status(400).json({ success: false, message: '文件夹名称不能为空' });
    const nextParent = req.body.parentId !== undefined
      ? (req.body.parentId ? Number(req.body.parentId) : null)
      : folder.parent_id;
    if (nextParent === folder.id) {
      return res.status(400).json({ success: false, message: '不能将文件夹移动到自身' });
    }
    if (nextParent) {
      if (!(await folderById(nextParent))) {
        return res.status(404).json({ success: false, message: '目标文件夹不存在' });
      }
      const subtree = await collectSubtreeFolderIds(folder.id);
      if (subtree.includes(nextParent)) {
        return res.status(400).json({ success: false, message: '不能将文件夹移动到其子目录中' });
      }
    }
    if (await siblingFolderExists(nextParent, nextName, folder.id)) {
      return res.status(409).json({ success: false, message: '目标目录下已存在同名文件夹' });
    }
    await pool.execute('UPDATE drive_folders SET name = ?, parent_id = ? WHERE id = ?', [nextName, nextParent, folder.id]);
    res.json({ success: true, data: publicFolder(await folderById(folder.id), req.user) });
  } catch (e) { next(e); }
});

router.delete('/folders/:id', async (req, res, next) => {
  try {
    const folder = await folderById(req.params.id);
    if (!folder) return res.status(404).json({ success: false, message: '文件夹不存在' });
    if (!canMutate(req.user, folder.owner_id)) {
      return res.status(403).json({ success: false, message: '只能删除自己创建的文件夹' });
    }
    const subtreeIds = await collectSubtreeFolderIds(folder.id);
    const placeholders = subtreeIds.map(() => '?').join(',');
    if (!isTeacher(req.user)) {
      const [otherFolders] = await pool.execute(
        `SELECT id FROM drive_folders WHERE id IN (${placeholders}) AND owner_id <> ? LIMIT 1`,
        [...subtreeIds, req.user.id],
      );
      const [otherFiles] = await pool.execute(
        `SELECT id FROM files WHERE folder_id IN (${placeholders}) AND deleted_at IS NULL AND uploader_id <> ? LIMIT 1`,
        [...subtreeIds, req.user.id],
      );
      if (otherFolders.length || otherFiles.length) {
        return res.status(403).json({ success: false, message: '文件夹内包含其他用户上传的资料，无法删除' });
      }
    }
    const db = await pool.getConnection();
    try {
      await db.beginTransaction();
      await db.execute(
        `UPDATE drive_folders SET deleted_at = NOW(), deleted_by = ? WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
        [req.user.id, ...subtreeIds],
      );
      await db.execute(
        `UPDATE kl_resources r JOIN files f ON f.ai_resource_id = r.id SET r.visibility = 'withdrawn' WHERE f.folder_id IN (${placeholders}) AND f.deleted_at IS NULL`,
        subtreeIds,
      );
      await db.execute(
        `UPDATE files SET deleted_at = NOW(), deleted_by = ? WHERE folder_id IN (${placeholders}) AND deleted_at IS NULL`,
        [req.user.id, ...subtreeIds],
      );
      await db.commit();
    } catch (err) {
      await db.rollback();
      throw err;
    } finally {
      db.release();
    }
    res.json({ success: true, data: { deletedFolderIds: subtreeIds } });
  } catch (e) { next(e); }
});

router.post('/files/upload', upload.single('file'), async (req, res, next) => {
  let tempPath = req.file?.path || '';
  try {
    if (!req.file) return res.status(400).json({ success: false, message: '请选择要上传的文件' });
    const folderId = req.body.folderId ? Number(req.body.folderId) : null;
    let folder = null;
    if (folderId) {
      folder = await folderById(folderId);
      if (!folder) {
        await fsp.unlink(tempPath).catch(() => {});
        return res.status(404).json({ success: false, message: '目标文件夹不存在' });
      }
    }
    const category = folder?.legacy_category || 'A';
    const rawName = decodeUploadName(req.file.originalname);
    const originalName = safeName(req.body.clientFileName || req.body.fileName || rawName, '未命名文件');
    const storedName = makeStoredName(originalName);
    const dir = path.join(UPLOAD_ROOT, category);
    await fsp.mkdir(dir, { recursive: true });
    const finalPath = path.join(dir, storedName);
    await fsp.rename(tempPath, finalPath);
    tempPath = '';

    const storagePath = `${category}/${storedName}`;
    const fileType = safeExt(originalName).replace('.', '');
    const indexStatus = AI_INDEX_EXTS.has(safeExt(originalName)) ? 'queued' : 'none';

    try {
      const [result] = await pool.execute(
        `INSERT INTO files (category, folder_id, original_name, stored_name, storage_path, file_type, mime_type, file_size, uploader_id, ai_index_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [category, folderId, originalName, storedName, storagePath, fileType, req.file.mimetype || '', Number(req.file.size || 0), req.user.id, indexStatus],
      );
      const row = await fileById(result.insertId);
      if (indexStatus === 'queued') triggerAiIndex(req.user, row);
      res.status(201).json({ success: true, data: publicDriveFile(row, req.user) });
    } catch (dbErr) {
      await fsp.unlink(finalPath).catch(() => {});
      throw dbErr;
    }
  } catch (e) {
    if (tempPath) await fsp.unlink(tempPath).catch(() => {});
    next(e);
  }
});

router.patch('/files/:id', async (req, res, next) => {
  try {
    const file = await fileById(req.params.id);
    if (!file) return res.status(404).json({ success: false, message: '文件不存在' });
    if (!canMutate(req.user, file.uploader_id)) {
      return res.status(403).json({ success: false, message: '只能修改自己上传的文件' });
    }
    const nextName = req.body.name !== undefined ? safeName(req.body.name, '') : file.original_name;
    if (!nextName) return res.status(400).json({ success: false, message: '文件名不能为空' });
    const nextFolder = req.body.folderId !== undefined
      ? (req.body.folderId ? Number(req.body.folderId) : null)
      : file.folder_id;
    if (nextFolder && !(await folderById(nextFolder))) {
      return res.status(404).json({ success: false, message: '目标文件夹不存在' });
    }
    await pool.execute('UPDATE files SET original_name = ?, folder_id = ? WHERE id = ?', [nextName, nextFolder, file.id]);
    res.json({ success: true, data: publicDriveFile(await fileById(file.id), req.user) });
  } catch (e) { next(e); }
});

router.delete('/files/:id', async (req, res, next) => {
  try {
    const file = await fileById(req.params.id);
    if (!file) return res.status(404).json({ success: false, message: '文件不存在' });
    if (!canMutate(req.user, file.uploader_id)) {
      return res.status(403).json({ success: false, message: '只能删除自己上传的文件' });
    }
    await pool.execute('UPDATE files SET deleted_at = NOW(), deleted_by = ? WHERE id = ?', [req.user.id, file.id]);
    if (file.ai_resource_id) {
      await pool.execute("UPDATE kl_resources SET visibility = 'withdrawn' WHERE id = ?", [file.ai_resource_id]).catch(() => {});
    }
    res.json({ success: true, data: { id: file.id } });
  } catch (e) { next(e); }
});

router.get('/files/:id/download', async (req, res, next) => {
  try {
    const file = await fileById(req.params.id);
    if (!file) return res.status(404).json({ success: false, message: '文件不存在' });
    const filePath = storedFilePath(file.storage_path);
    try { await fsp.access(filePath); } catch {
      return res.status(404).json({ success: false, message: '服务器上的文件不存在' });
    }
    return res.download(filePath, file.original_name);
  } catch (e) { next(e); }
});

router.get('/folders/:id/export', async (req, res, next) => {
  try {
    const folder = await folderById(req.params.id);
    if (!folder) return res.status(404).json({ success: false, message: '文件夹不存在' });
    const subtreeIds = await collectSubtreeFolderIds(folder.id);
    const placeholders = subtreeIds.map(() => '?').join(',');
    const [files] = await pool.execute(
      `SELECT id, original_name, storage_path FROM files WHERE folder_id IN (${placeholders}) AND deleted_at IS NULL ORDER BY created_at DESC`,
      subtreeIds,
    );
    const available = [];
    for (const row of files) {
      try {
        const p = storedFilePath(row.storage_path);
        await fsp.access(p);
        available.push({ row, filePath: p });
      } catch {}
    }
    if (!available.length) return res.status(404).json({ success: false, message: '当前目录没有可导出的文件' });
    const zipName = `${safeName(folder.name, '资料')}_${Date.now()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('error', err => { if (!res.headersSent) res.status(500).json({ success: false, message: 'ZIP 创建失败' }); else res.destroy(err); });
    archive.pipe(res);
    available.forEach(({ row, filePath }, i) => {
      archive.file(filePath, { name: `${String(i + 1).padStart(3, '0')}_${safeName(row.original_name)}` });
    });
    await archive.finalize();
  } catch (e) { next(e); }
});

router.post('/files/:id/reindex', async (req, res, next) => {
  try {
    const file = await fileById(req.params.id);
    if (!file) return res.status(404).json({ success: false, message: '文件不存在' });
    if (!canMutate(req.user, file.uploader_id)) {
      return res.status(403).json({ success: false, message: '无权重新索引此文件' });
    }
    if (!AI_INDEX_EXTS.has(safeExt(file.original_name))) {
      return res.status(400).json({ success: false, message: '此文件类型暂不支持文本索引' });
    }
    await pool.execute("UPDATE files SET ai_index_status = 'queued', ai_index_error = NULL WHERE id = ?", [file.id]);
    triggerAiIndex(req.user, file);
    res.json({ success: true, data: { status: 'queued' } });
  } catch (e) { next(e); }
});

router.get('/trash', async (req, res, next) => {
  try {
    const teacher = isTeacher(req.user);
    const [folders] = await pool.execute(
      `SELECT d.*, u.display_name AS owner_name FROM drive_folders d LEFT JOIN users u ON u.id = d.owner_id
       WHERE d.deleted_at IS NOT NULL ${teacher ? '' : 'AND d.owner_id = ?'} ORDER BY d.deleted_at DESC`,
      teacher ? [] : [req.user.id],
    );
    const [files] = await pool.execute(
      `SELECT f.*, u.display_name AS uploader_name FROM files f LEFT JOIN users u ON u.id = f.uploader_id
       WHERE f.deleted_at IS NOT NULL ${teacher ? '' : 'AND f.uploader_id = ?'} ORDER BY f.deleted_at DESC`,
      teacher ? [] : [req.user.id],
    );
    res.json({
      success: true,
      data: {
        folders: folders.map(r => ({ ...publicFolder(r, req.user), deleted_at: r.deleted_at })),
        files: files.map(r => ({ ...publicDriveFile(r, req.user), deleted_at: r.deleted_at })),
      },
    });
  } catch (e) { next(e); }
});

router.post('/trash/restore', async (req, res, next) => {
  try {
    const { type, id } = req.body;
    if (type === 'folder') {
      const folder = await folderById(id, true);
      if (!folder || !folder.deleted_at) return res.status(404).json({ success: false, message: '回收站中未找到该文件夹' });
      if (!canMutate(req.user, folder.owner_id)) return res.status(403).json({ success: false, message: '只能恢复自己删除的文件夹' });
      const parentAlive = folder.parent_id ? Boolean(await folderById(folder.parent_id)) : true;
      await pool.execute(
        'UPDATE drive_folders SET deleted_at = NULL, deleted_by = NULL, parent_id = ? WHERE id = ?',
        [parentAlive ? folder.parent_id : null, folder.id],
      );
      return res.json({ success: true, data: { id: folder.id } });
    }
    const file = await fileById(id, true);
    if (!file || !file.deleted_at) return res.status(404).json({ success: false, message: '回收站中未找到该文件' });
    if (!canMutate(req.user, file.uploader_id)) return res.status(403).json({ success: false, message: '只能恢复自己删除的文件' });
    const folderAlive = file.folder_id ? Boolean(await folderById(file.folder_id)) : true;
    await pool.execute(
      'UPDATE files SET deleted_at = NULL, deleted_by = NULL, folder_id = ? WHERE id = ?',
      [folderAlive ? file.folder_id : null, file.id],
    );
    if (file.ai_resource_id) {
      await pool.execute("UPDATE kl_resources SET visibility = 'public' WHERE id = ?", [file.ai_resource_id]).catch(() => {});
    }
    res.json({ success: true, data: { id: file.id } });
  } catch (e) { next(e); }
});

router.delete('/trash/:type/:id', requireTeacher, async (req, res, next) => {
  try {
    const { type, id } = req.params;
    if (type === 'folder') {
      const folder = await folderById(id, true);
      if (!folder?.deleted_at) return res.status(404).json({ success: false, message: '回收站中未找到该文件夹' });
      const [childFiles] = await pool.execute('SELECT id, storage_path FROM files WHERE folder_id = ?', [folder.id]);
      for (const f of childFiles) {
        await fsp.unlink(storedFilePath(f.storage_path)).catch(() => {});
        await pool.execute('DELETE FROM files WHERE id = ?', [f.id]);
      }
      await pool.execute('UPDATE drive_folders SET parent_id = NULL WHERE parent_id = ?', [folder.id]);
      await pool.execute('DELETE FROM drive_folders WHERE id = ?', [folder.id]);
      return res.json({ success: true, data: { id: folder.id } });
    }
    const file = await fileById(id, true);
    if (!file?.deleted_at) return res.status(404).json({ success: false, message: '回收站中未找到该文件' });
    await fsp.unlink(storedFilePath(file.storage_path)).catch(() => {});
    await pool.execute('DELETE FROM files WHERE id = ?', [file.id]);
    res.json({ success: true, data: { id: file.id } });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.helpers = { canMutate, safeName, safeExt };
