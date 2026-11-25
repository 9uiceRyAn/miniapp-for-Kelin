const express = require('express');
const multer = require('multer');
const { ZipArchive } = require('archiver');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { pool } = require('../db');
const {
  requireAuth,
  requireTeacher,
} = require('../middleware/auth');

const { decodeUploadName } = require('../utils/upload-name');
const router = express.Router();

const { CATEGORIES, cleanCategory } = require('../utils/file-category');

const { UPLOAD_ROOT, storedFilePath } = require('../utils/file-storage');

const TEMP_ROOT = path.join(
  UPLOAD_ROOT,
  '.tmp',
);

const MAX_UPLOAD_MB = Number(
  process.env.MAX_UPLOAD_MB || 200,
);

fs.mkdirSync(TEMP_ROOT, {
  recursive: true,
});



function safeOriginalName(name) {
  const value = String(
    name || '未命名文件',
  )
    .replace(
      /[\\/:*?"<>|\u0000-\u001f]/g,
      '_',
    )
    .trim();

  return value.slice(0, 180) ||
    '未命名文件';
}


function safeExtension(fileName) {
  const ext = path
    .extname(String(fileName || ''))
    .toLowerCase();

  if (
    !/^\.[a-z0-9]{1,12}$/.test(ext)
  ) {
    return '';
  }

  return ext;
}


function makeStoredName(originalName) {
  const extension =
    safeExtension(originalName);

  const random =
    crypto.randomBytes(12)
      .toString('hex');

  return `${
    Date.now()
  }_${random}${extension}`;
}


function publicFile(row) {
  return {
    id: row.id,
    category: row.category,
    original_name: row.original_name,
    file_size: Number(
      row.file_size || 0,
    ),
    mime_type: row.mime_type || '',
    file_type: row.file_type || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    uploader_name:
      row.uploader_name || '',
  };
}




async function findFileById(id) {
  const [rows] = await pool.execute(
    `
    SELECT
      f.id,
      f.category,
      f.original_name,
      f.stored_name,
      f.storage_path,
      f.file_type,
      f.mime_type,
      f.file_size,
      f.uploader_id,
      f.created_at,
      f.updated_at,
      u.display_name AS uploader_name
    FROM files f
    LEFT JOIN users u
      ON u.id = f.uploader_id
    WHERE f.id = ?
    LIMIT 1
    `,
    [id],
  );

  return rows[0] || null;
}


const upload = multer({
  dest: TEMP_ROOT,

  limits: {
    fileSize:
      MAX_UPLOAD_MB *
      1024 *
      1024,
  },
});


/**
 * A-E 各分类文件数量
 */
router.get(
  '/counts',
  requireAuth,
  async (req, res) => {
    try {
      const [rows] =
        await pool.query(
          `
          SELECT
            category,
            COUNT(*) AS total
          FROM files
          GROUP BY category
          `,
        );

      const counts = {
        A: 0,
        B: 0,
        C: 0,
        D: 0,
        E: 0,
      };

      rows.forEach((row) => {
        if (
          CATEGORIES.has(row.category)
        ) {
          counts[row.category] =
            Number(row.total || 0);
        }
      });

      return res.json({
        success: true,
        data: counts,
      });
    } catch (error) {
      console.error(
        'counts error:',
        error,
      );

      return res.status(500).json({
        success: false,
        message:
          '获取文件数量失败',
      });
    }
  },
);


/**
 * 整个分类 ZIP 下载
 *
 * 注意：必须放在 /:id 路由前面。
 */
router.get(
  '/export/:category',
  requireAuth,
  async (req, res) => {
    try {
      const category =
        cleanCategory(
          req.params.category,
        );

      if (
        !CATEGORIES.has(category)
      ) {
        return res.status(400).json({
          success: false,
          message: '文件分类无效',
        });
      }

      const [rows] =
        await pool.execute(
          `
          SELECT
            id,
            original_name,
            storage_path
          FROM files
          WHERE category = ?
          ORDER BY created_at DESC
          `,
          [category],
        );

      if (!rows.length) {
        return res.status(404).json({
          success: false,
          message:
            '当前分类没有文件',
        });
      }

      const availableFiles = [];

      for (
        let index = 0;
        index < rows.length;
        index += 1
      ) {
        const row = rows[index];

        try {
          const filePath =
            storedFilePath(row.storage_path);

          await fsp.access(filePath);

          availableFiles.push({
            row,
            filePath,
          });
        } catch (error) {
          console.warn(
            'ZIP 跳过不存在的文件:',
            row.id,
            error.message,
          );
        }
      }

      if (!availableFiles.length) {
        return res.status(404).json({
          success: false,
          message:
            '没有可导出的实际文件',
        });
      }

      const fileName =
        `${category}类文件_${
          Date.now()
        }.zip`;

      res.setHeader(
        'Content-Type',
        'application/zip',
      );

      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${
          encodeURIComponent(
            fileName,
          )
        }`,
      );

      const archive =
        new ZipArchive(
          {
            zlib: {
              level: 6,
            },
          },
        );

      archive.on(
        'warning',
        (error) => {
          console.warn(
            'archiver warning:',
            error,
          );
        },
      );

      archive.on(
        'error',
        (error) => {
          console.error(
            'archiver error:',
            error,
          );

          if (!res.headersSent) {
            res.status(500).json({
              success: false,
              message:
                'ZIP 创建失败',
            });
          } else {
            res.destroy(error);
          }
        },
      );

      archive.pipe(res);

      availableFiles.forEach(
        ({ row, filePath }, index) => {
          const zipName =
            `${
              String(index + 1)
                .padStart(3, '0')
            }_${
              safeOriginalName(
                row.original_name,
              )
            }`;

          archive.file(
            filePath,
            {
              name: zipName,
            },
          );
        },
      );

      await archive.finalize();
    } catch (error) {
      console.error(
        'export category error:',
        error,
      );

      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message:
            '导出分类失败',
        });
      }

      return undefined;
    }
  },
);


/**
 * 文件列表
 *
 * /api/files?category=A
 */
router.get(
  '/',
  requireAuth,
  async (req, res) => {
    try {
      const category =
        cleanCategory(
          req.query.category,
        );

      if (
        !CATEGORIES.has(category)
      ) {
        return res.status(400).json({
          success: false,
          message: '文件分类无效',
        });
      }

      const [rows] =
        await pool.execute(
          `
          SELECT
            f.id,
            f.category,
            f.original_name,
            f.file_type,
            f.mime_type,
            f.file_size,
            f.created_at,
            f.updated_at,
            u.display_name
              AS uploader_name
          FROM files f
          LEFT JOIN users u
            ON u.id =
               f.uploader_id
          WHERE f.category = ?
          ORDER BY
            f.created_at DESC,
            f.id DESC
          `,
          [category],
        );

      return res.json({
        success: true,
        data: rows.map(publicFile),
      });
    } catch (error) {
      console.error(
        'list files error:',
        error,
      );

      return res.status(500).json({
        success: false,
        message:
          '获取文件列表失败',
      });
    }
  },
);


/**
 * 上传文件
 *
 * 仅教师
 *
 * multipart/form-data:
 * file
 * category
 */
router.post(
  '/upload',
  requireAuth,
  requireTeacher,
  upload.single('file'),
  async (req, res) => {
    let tempPath = '';

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message:
            '请选择要上传的文件',
        });
      }

      tempPath = req.file.path;

      const category =
        cleanCategory(
          req.body.category,
        );

      if (
        !CATEGORIES.has(category)
      ) {
        await fsp.unlink(
          tempPath,
        ).catch(() => {});

        return res.status(400).json({
          success: false,
          message: '文件分类无效',
        });
      }

      const multipartOriginalName =
        decodeUploadName(req.file.originalname);

      const originalName =
        safeOriginalName(
          req.body.clientFileName ||
          multipartOriginalName,
        );

      const storedName =
        makeStoredName(
          originalName,
        );

      const categoryDir =
        path.join(
          UPLOAD_ROOT,
          category,
        );

      await fsp.mkdir(
        categoryDir,
        {
          recursive: true,
        },
      );

      const finalPath =
        path.join(
          categoryDir,
          storedName,
        );

      await fsp.rename(
        tempPath,
        finalPath,
      );

      tempPath = '';

      const storagePath =
        `${category}/${storedName}`;

      const fileType =
        safeExtension(
          originalName,
        ).replace('.', '');

      try {
        const [result] =
          await pool.execute(
            `
            INSERT INTO files
              (
                category,
                original_name,
                stored_name,
                storage_path,
                file_type,
                mime_type,
                file_size,
                uploader_id
              )
            VALUES
              (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              category,
              originalName,
              storedName,
              storagePath,
              fileType,
              req.file.mimetype || '',
              Number(
                req.file.size || 0,
              ),
              req.user.id,
            ],
          );

        const row =
          await findFileById(
            result.insertId,
          );

        return res.status(201).json({
          success: true,
          data: publicFile(row),
        });
      } catch (databaseError) {
        await fsp.unlink(
          finalPath,
        ).catch(() => {});

        throw databaseError;
      }
    } catch (error) {
      if (tempPath) {
        await fsp.unlink(
          tempPath,
        ).catch(() => {});
      }

      console.error(
        'upload error:',
        error,
      );


      return res.status(500).json({
        success: false,
        message: '上传文件失败',
      });
    }
  },
);


/**
 * 单个文件信息
 */
router.get(
  '/:id',
  requireAuth,
  async (req, res) => {
    try {
      const row =
        await findFileById(
          req.params.id,
        );

      if (!row) {
        return res.status(404).json({
          success: false,
          message:
            '文件记录不存在',
        });
      }

      return res.json({
        success: true,
        data: publicFile(row),
      });
    } catch (error) {
      console.error(
        'get file error:',
        error,
      );

      return res.status(500).json({
        success: false,
        message:
          '获取文件信息失败',
      });
    }
  },
);


/**
 * 单文件下载
 */
router.get(
  '/:id/download',
  requireAuth,
  async (req, res) => {
    try {
      const row =
        await findFileById(
          req.params.id,
        );

      if (!row) {
        return res.status(404).json({
          success: false,
          message:
            '文件记录不存在',
        });
      }

      const filePath =
        storedFilePath(row.storage_path);

      try {
        await fsp.access(filePath);
      } catch (error) {
        return res.status(404).json({
          success: false,
          message:
            '服务器上的文件不存在',
        });
      }

      return res.download(
        filePath,
        row.original_name,
      );
    } catch (error) {
      console.error(
        'download error:',
        error,
      );

      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message:
            '下载文件失败',
        });
      }

      return undefined;
    }
  },
);


/**
 * 删除
 *
 * 仅教师
 */
router.delete(
  '/:id',
  requireAuth,
  requireTeacher,
  async (req, res) => {
    try {
      const row =
        await findFileById(
          req.params.id,
        );

      if (!row) {
        return res.status(404).json({
          success: false,
          message:
            '文件记录不存在',
        });
      }

      const filePath =
        storedFilePath(row.storage_path);

      await fsp.unlink(
        filePath,
      ).catch((error) => {
        if (
          error.code !== 'ENOENT'
        ) {
          throw error;
        }
      });

      await pool.execute(
        `
        DELETE FROM files
        WHERE id = ?
        `,
        [row.id],
      );

      return res.json({
        success: true,
        data: {
          message: '删除成功',
        },
      });
    } catch (error) {
      console.error(
        'delete file error:',
        error,
      );

      return res.status(500).json({
        success: false,
        message:
          '删除文件失败',
      });
    }
  },
);


module.exports = router;
