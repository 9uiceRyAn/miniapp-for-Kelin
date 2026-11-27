const express = require('express');
const fs = require('node:fs/promises');
const { pool } = require('../db');
const { requireAuth, requireTeacher } = require('../middleware/auth');
const { CATEGORIES, cleanCategory, LEGACY_FILES } = require('../utils/file-category');
const {
  ensureLegacyFolders,
  uploadSingle,
  saveUpload,
  recycleFile,
  sendDownload,
  sendZip,
} = require('./drive').fileOperations;

const router = express.Router();
router.use(requireAuth);

function legacyFile(row) {
  return {
    id: row.id,
    category: row.legacy_category,
    original_name: row.original_name,
    file_size: Number(row.file_size || 0),
    mime_type: row.mime_type || '',
    file_type: row.file_type || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    uploader_name: row.uploader_name || '',
  };
}

function invalidCategory(res) {
  return res.status(400).json({ success: false, message: '文件分类无效' });
}

function missingFile(res) {
  return res.status(404).json({ success: false, message: '文件记录不存在' });
}

async function fileInLegacyFolder(id) {
  const [rows] = await pool.execute(
    'SELECT f.*, d.legacy_category, u.display_name AS uploader_name FROM ' +
      LEGACY_FILES + ' LEFT JOIN users u ON u.id = f.uploader_id WHERE f.id = ? LIMIT 1',
    [id],
  );
  return rows[0];
}

router.get('/counts', async (req, res) => {
  const counts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const [rows] = await pool.query(
    'SELECT d.legacy_category, COUNT(*) AS total FROM ' + LEGACY_FILES + ' GROUP BY d.legacy_category',
  );
  for (const { legacy_category: category, total } of rows) {
    if (CATEGORIES.has(category)) counts[category] = Number(total);
  }
  res.json({ success: true, data: counts });
});

router.get('/', async (req, res) => {
  const category = cleanCategory(req.query.category);
  if (!CATEGORIES.has(category)) return invalidCategory(res);
  const [rows] = await pool.execute(
    'SELECT f.*, d.legacy_category, u.display_name AS uploader_name FROM ' +
      LEGACY_FILES + ' LEFT JOIN users u ON u.id = f.uploader_id' +
      ' WHERE d.legacy_category = ? ORDER BY f.created_at DESC, f.id DESC',
    [category],
  );
  res.json({ success: true, data: rows.map(legacyFile) });
});

router.get('/export/:category', async (req, res) => {
  const category = cleanCategory(req.params.category);
  if (!CATEGORIES.has(category)) return invalidCategory(res);
  const [rows] = await pool.execute(
    'SELECT f.original_name, f.storage_path FROM ' + LEGACY_FILES +
      ' WHERE d.legacy_category = ? ORDER BY f.created_at DESC, f.id DESC',
    [category],
  );
  return sendZip(rows, category + '类文件_' + Date.now() + '.zip', res, '当前分类没有可导出的文件');
});

router.post('/upload', requireTeacher, uploadSingle, async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: '请选择要上传的文件' });
  try {
    const category = cleanCategory(req.body.category);
    if (!CATEGORIES.has(category)) return invalidCategory(res);
    await ensureLegacyFolders();
    const [rows] = await pool.execute(
      'SELECT id, legacy_category FROM drive_folders WHERE legacy_category = ? AND deleted_at IS NULL',
      [category],
    );
    const folder = rows[0];
    if (!folder) return res.status(404).json({ success: false, message: '目标分类不存在' });
    const name = req.body.clientFileName;
    const file = await saveUpload(req.file, folder, name, req.user, { index: false });
    res.status(201).json({ success: true, data: legacyFile({ ...file, legacy_category: category }) });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
});

router.get('/:id', async (req, res) => {
  const file = await fileInLegacyFolder(req.params.id);
  if (!file) return missingFile(res);
  res.json({ success: true, data: legacyFile(file) });
});

router.get('/:id/download', async (req, res) => {
  const file = await fileInLegacyFolder(req.params.id);
  if (!file) return missingFile(res);
  return sendDownload(file, res);
});

router.delete('/:id', requireTeacher, async (req, res) => {
  const file = await fileInLegacyFolder(req.params.id);
  if (!file || !(await recycleFile(file.id, req.user.id, file.folder_id))) return missingFile(res);
  res.json({ success: true, data: { message: '删除成功' } });
});

module.exports = router;
