const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { pool, transaction } = require('../db');
const { UPLOAD_ROOT } = require('../utils/file-storage');
const {
  hashPassword,
  verifyPassword,
  randomToken,
  hashToken,
} = require('../utils/security');

const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const { validateCode } = require('../registration-codes');

const AVATAR_DIR = path.join(UPLOAD_ROOT, 'avatars');
const AVATAR_MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
  },
});

async function createSession(db, userId) {
  const token = randomToken();
  const expires = addHours(Number(process.env.SESSION_TTL_HOURS || 12));
  await db.execute('INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [userId, hashToken(token), expires]);
  return token;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    role: user.role,
    avatarUrl: user.avatar_url || '',
  };
}

function cleanText(value, maxLength = 100) {
  return String(value || '').trim().slice(0, maxLength);
}

function addHours(hours) {
  const date = new Date();
  date.setHours(date.getHours() + Number(hours));
  return date;
}

function addDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + Number(days));
  return date;
}


/**
 * 注册
 */
router.post('/register', async (req, res) => {
  try {
    const username = cleanText(req.body.username, 30);
    const displayName =
      cleanText(req.body.displayName, 30) || username;

    const password = String(req.body.password || '');
    const role =
      req.body.role === 'teacher'
        ? 'teacher'
        : 'student';

    const registerCode =
      String(req.body.registerCode || '');

    if (!/^[A-Za-z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({
        success: false,
        message:
          '用户名只能包含字母、数字、下划线，长度 3–30 位',
      });
    }

    if (
      password.length < 6 ||
      password.length > 72
    ) {
      return res.status(400).json({
        success: false,
        message: '密码长度必须为 6–72 位',
      });
    }

    if (!(await validateCode(role, registerCode))) {
      return res.status(403).json({
        success: false,
        message: '内部注册码不正确',
      });
    }

    const [existing] = await pool.execute(
      `
      SELECT id
      FROM users
      WHERE username = ?
      LIMIT 1
      `,
      [username],
    );

    if (existing.length) {
      return res.status(409).json({
        success: false,
        message: '该用户名已存在',
      });
    }

    const passwordHash =
      hashPassword(password);

    await pool.execute(
      `
      INSERT INTO users
        (
          username,
          password_hash,
          display_name,
          role,
          status
        )
      VALUES (?, ?, ?, ?, 1)
      `,
      [
        username,
        passwordHash,
        displayName,
        role,
      ],
    );

    return res.json({
      success: true,
      data: {
        message: '账号创建成功，请返回登录。',
      },
    });
  } catch (error) {
    console.error('register error:', error);

    if (
      error &&
      error.code === 'ER_DUP_ENTRY'
    ) {
      return res.status(409).json({
        success: false,
        message: '该用户名已存在',
      });
    }

    return res.status(500).json({
      success: false,
      message: '注册失败',
    });
  }
});


/**
 * 登录
 */
router.post('/login', async (req, res) => {
  try {
    const username =
      cleanText(req.body.username, 30);

    const password =
      String(req.body.password || '');

    const rememberDevice =
      req.body.rememberDevice !== false;

    const result = await transaction(async db => {
      // Password resets lock this same user before revoking sessions and devices.
      const [rows] = await db.execute(
        'SELECT id, username, password_hash, display_name, role, status, avatar_url FROM users WHERE username = ? FOR UPDATE',
        [username],
      );
      const user = rows[0];
      if (!user || user.status !== 1 || !verifyPassword(password, user.password_hash)) return null;

      const token = await createSession(db, user.id);
      let rememberToken = '';
      if (rememberDevice) {
        rememberToken = randomToken();
        await db.execute(
          `INSERT INTO remember_devices
             (user_id, token_hash, device_name, user_agent, expires_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, NOW())`,
          [
            user.id, hashToken(rememberToken),
            cleanText(req.body.deviceName, 255) || '微信小程序',
            cleanText(req.headers['user-agent'], 500),
            addDays(Number(process.env.REMEMBER_DEVICE_DAYS || 30)),
          ],
        );
      }
      return { token, rememberToken, user: publicUser(user) };
    });
    if (!result) return res.status(401).json({ success: false, message: '用户名或密码错误' });
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('login error:', error);

    return res.status(500).json({
      success: false,
      message: '登录失败',
    });
  }
});


/**
 * 当前用户
 */
router.get('/me', requireAuth, async (req, res) => {
  return res.json({
    success: true,
    data: {
      user: publicUser(req.user),
    },
  });
});


/**
 * 退出登录
 */
router.post('/logout', async (req, res) => {
  try {
    const authorization =
      String(req.headers.authorization || '');

    const sessionToken =
      authorization.startsWith('Bearer ')
        ? authorization.slice(7).trim()
        : '';

    const rememberToken =
      String(req.body.rememberToken || '');

    if (sessionToken) {
      await pool.execute(
        `
        DELETE FROM auth_sessions
        WHERE token_hash = ?
        `,
        [hashToken(sessionToken)],
      );
    }

    if (rememberToken) {
      await pool.execute(
        `
        UPDATE remember_devices
        SET revoked_at = NOW()
        WHERE token_hash = ?
          AND revoked_at IS NULL
        `,
        [hashToken(rememberToken)],
      );
    }

    return res.json({
      success: true,
      data: {
        message: '已退出登录',
      },
    });
  } catch (error) {
    console.error('logout error:', error);

    return res.status(500).json({
      success: false,
      message: '退出登录失败',
    });
  }
});


/**
 * 记住设备自动登录
 */
router.post('/remember-login', async (req, res) => {
  try {
    const rememberToken =
      String(req.body.rememberToken || '');

    if (!rememberToken) {
      return res.status(401).json({
        success: false,
        message: '缺少记住设备凭证',
      });
    }

    const rememberTokenHash =
      hashToken(rememberToken);

    const result = await transaction(async db => {
      // Identify the owner without locking the device first. Reset locks user, then devices.
      const [devices] = await db.execute(
        'SELECT id, user_id FROM remember_devices WHERE token_hash = ? LIMIT 1',
        [rememberTokenHash],
      );
      const device = devices[0];
      if (!device) return null;
      const [users] = await db.execute(
        'SELECT id, username, display_name, role, status, avatar_url FROM users WHERE id = ? FOR UPDATE',
        [device.user_id],
      );
      const user = users[0];
      if (!user || user.status !== 1) return null;
      const [active] = await db.execute(
        `SELECT id FROM remember_devices WHERE id = ? AND user_id = ? AND token_hash = ?
           AND revoked_at IS NULL AND expires_at > NOW() FOR UPDATE`,
        [device.id, user.id, rememberTokenHash],
      );
      if (!active.length) return null;

      await db.execute('UPDATE remember_devices SET last_used_at = NOW() WHERE id = ?', [device.id]);
      const token = await createSession(db, user.id);
      return { token, rememberToken, user: publicUser(user) };
    });
    if (!result) return res.status(401).json({ success: false, message: '记住设备凭证已失效，请重新登录' });
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error(
      'remember-login error:',
      error,
    );

    return res.status(500).json({
      success: false,
      message: '自动登录失败',
    });
  }
});


/**
 * 上传头像
 */
router.post('/avatar', requireAuth, avatarUpload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ success: false, message: '请选择头像图片' });
    }
    const mime = String(req.file.mimetype || '').toLowerCase();
    const ext = AVATAR_MIME_EXT[mime];
    if (!ext) {
      return res.status(400).json({ success: false, message: '仅支持 JPG、PNG、WebP 或 GIF 图片' });
    }

    await fs.promises.mkdir(AVATAR_DIR, { recursive: true });
    const filename = `${req.user.id}_${crypto.randomBytes(12).toString('hex')}${ext}`;
    const targetPath = path.join(AVATAR_DIR, filename);
    await fs.promises.writeFile(targetPath, req.file.buffer);

    const avatarUrl = `/api/auth/avatars/${filename}`;
    await pool.execute('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, req.user.id]);

    const prevUrl = String(req.user.avatar_url || '');
    if (prevUrl.startsWith('/api/auth/avatars/')) {
      const prevName = prevUrl.slice('/api/auth/avatars/'.length);
      if (/^[A-Za-z0-9_.-]+$/.test(prevName) && !prevName.includes('..')) {
        fs.promises.unlink(path.join(AVATAR_DIR, prevName)).catch(() => {});
      }
    }

    return res.json({ success: true, data: { avatarUrl } });
  } catch (error) {
    console.error('avatar upload error:', error);
    return res.status(500).json({ success: false, message: '头像上传失败' });
  }
});

/**
 * 获取头像
 */
router.get('/avatars/:filename', (req, res) => {
  const filename = String(req.params.filename || '');
  if (!/^[A-Za-z0-9_.-]+$/.test(filename) || filename.includes('..')) {
    return res.status(400).json({ success: false, message: '无效的头像文件名' });
  }
  const avatarRoot = path.resolve(AVATAR_DIR);
  const filePath = path.resolve(avatarRoot, filename);
  if (!filePath.startsWith(avatarRoot + path.sep)) {
    return res.status(400).json({ success: false, message: '无效的头像路径' });
  }
  res.set('Cache-Control', 'public, max-age=86400');
  return res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

module.exports = router;
