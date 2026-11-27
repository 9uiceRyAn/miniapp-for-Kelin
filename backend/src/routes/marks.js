const express = require('express');

const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { CATEGORIES, cleanCategory, LEGACY_FILES } = require('../utils/file-category');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const category = cleanCategory(req.query.category);
  if (!CATEGORIES.has(category)) {
    return res.status(400).json({ success: false, message: '文件分类无效' });
  }
  const [rows] = await pool.execute(
    'SELECT m.file_id FROM ' + LEGACY_FILES + ' JOIN user_file_marks m ON m.file_id = f.id' +
      ' WHERE d.legacy_category = ? AND m.user_id = ? ORDER BY m.marked_at DESC',
    [category, req.user.id],
  );
  res.json({ success: true, data: { fileIds: rows.map(row => Number(row.file_id)) } });
});

async function fileExists(fileId) {
  const [rows] = await pool.execute(
    `
    SELECT id
    FROM files
    WHERE id = ? AND deleted_at IS NULL
    LIMIT 1
    `,
    [fileId],
  );

  return Boolean(rows.length);
}

/**
 * 标记文件。
 *
 * PUT /api/marks/:fileId
 */
router.put(
  '/:fileId',
  requireAuth,
  async (req, res) => {
    try {
      const fileId =
        Number(req.params.fileId);

      if (
        !Number.isInteger(fileId) ||
        fileId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: '文件编号无效',
        });
      }

      if (!(await fileExists(fileId))) {
        return res.status(404).json({
          success: false,
          message: '文件不存在',
        });
      }

      await pool.execute(
        `
        INSERT INTO user_file_marks
          (
            user_id,
            file_id,
            marked_at
          )
        VALUES (?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          marked_at = NOW()
        `,
        [req.user.id, fileId],
      );

      return res.json({
        success: true,
        data: {
          fileId,
          marked: true,
        },
      });
    } catch (error) {
      console.error(
        'mark file error:',
        error,
      );

      return res.status(500).json({
        success: false,
        message: '标记文件失败',
      });
    }
  },
);

/**
 * 取消标记。
 *
 * DELETE /api/marks/:fileId
 */
router.delete(
  '/:fileId',
  requireAuth,
  async (req, res) => {
    try {
      const fileId =
        Number(req.params.fileId);

      if (
        !Number.isInteger(fileId) ||
        fileId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: '文件编号无效',
        });
      }

      await pool.execute(
        `
        DELETE FROM user_file_marks
        WHERE user_id = ?
          AND file_id = ?
        `,
        [req.user.id, fileId],
      );

      return res.json({
        success: true,
        data: {
          fileId,
          marked: false,
        },
      });
    } catch (error) {
      console.error(
        'unmark file error:',
        error,
      );

      return res.status(500).json({
        success: false,
        message: '取消文件标记失败',
      });
    }
  },
);

module.exports = router;
