const express = require('express');

const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const CATEGORIES = new Set([
  'A',
  'B',
  'C',
  'D',
  'E',
]);

function cleanCategory(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

async function fileExists(fileId) {
  const [rows] = await pool.execute(
    `
    SELECT id
    FROM files
    WHERE id = ?
    LIMIT 1
    `,
    [fileId],
  );

  return Boolean(rows.length);
}

/**
 * 当前用户在某个分类中已经标记的文件。
 *
 * GET /api/marks?category=A
 */
router.get(
  '/',
  requireAuth,
  async (req, res) => {
    try {
      const category =
        cleanCategory(req.query.category);

      if (!CATEGORIES.has(category)) {
        return res.status(400).json({
          success: false,
          message: '文件分类无效',
        });
      }

      const [rows] = await pool.execute(
        `
        SELECT m.file_id
        FROM user_file_marks m
        JOIN files f
          ON f.id = m.file_id
        WHERE m.user_id = ?
          AND f.category = ?
        ORDER BY m.marked_at DESC
        `,
        [req.user.id, category],
      );

      return res.json({
        success: true,
        data: {
          fileIds: rows.map(
            (row) => Number(row.file_id),
          ),
        },
      });
    } catch (error) {
      console.error(
        'list marks error:',
        error,
      );

      return res.status(500).json({
        success: false,
        message: '获取文件标记失败',
      });
    }
  },
);

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
