const express = require('express');

const { pool } = require('../db');
const {
  hashPassword,
  verifyPassword,
  randomToken,
  hashToken,
} = require('../utils/security');

const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    role: user.role,
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

    const expectedCode =
      role === 'teacher'
        ? process.env.TEACHER_REGISTER_CODE
        : process.env.STUDENT_REGISTER_CODE;

    if (
      !expectedCode ||
      registerCode !== expectedCode
    ) {
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

    const [rows] = await pool.execute(
      `
      SELECT
        id,
        username,
        password_hash,
        display_name,
        role,
        status
      FROM users
      WHERE username = ?
      LIMIT 1
      `,
      [username],
    );

    const user = rows[0];

    if (
      !user ||
      user.status !== 1 ||
      !verifyPassword(
        password,
        user.password_hash,
      )
    ) {
      return res.status(401).json({
        success: false,
        message: '用户名或密码错误',
      });
    }

    const sessionToken =
      randomToken();

    const sessionTokenHash =
      hashToken(sessionToken);

    const sessionHours =
      Number(
        process.env.SESSION_TTL_HOURS || 12,
      );

    const sessionExpiresAt =
      addHours(sessionHours);

    await pool.execute(
      `
      INSERT INTO auth_sessions
        (
          user_id,
          token_hash,
          expires_at
        )
      VALUES (?, ?, ?)
      `,
      [
        user.id,
        sessionTokenHash,
        sessionExpiresAt,
      ],
    );

    let rememberToken = '';

    if (rememberDevice) {
      rememberToken = randomToken();

      const rememberTokenHash =
        hashToken(rememberToken);

      const rememberDays =
        Number(
          process.env.REMEMBER_DEVICE_DAYS || 30,
        );

      const rememberExpiresAt =
        addDays(rememberDays);

      const deviceName =
        cleanText(
          req.body.deviceName,
          255,
        ) || '微信小程序';

      const userAgent =
        cleanText(
          req.headers['user-agent'],
          500,
        );

      await pool.execute(
        `
        INSERT INTO remember_devices
          (
            user_id,
            token_hash,
            device_name,
            user_agent,
            expires_at,
            last_used_at
          )
        VALUES (?, ?, ?, ?, ?, NOW())
        `,
        [
          user.id,
          rememberTokenHash,
          deviceName,
          userAgent,
          rememberExpiresAt,
        ],
      );
    }

    return res.json({
      success: true,
      data: {
        token: sessionToken,
        rememberToken,
        user: publicUser(user),
      },
    });
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

    const [rows] = await pool.execute(
      `
      SELECT
        rd.id AS remember_id,
        rd.user_id,
        u.id,
        u.username,
        u.display_name,
        u.role,
        u.status
      FROM remember_devices rd
      JOIN users u
        ON u.id = rd.user_id
      WHERE rd.token_hash = ?
        AND rd.expires_at > NOW()
        AND rd.revoked_at IS NULL
        AND u.status = 1
      LIMIT 1
      `,
      [rememberTokenHash],
    );

    const user = rows[0];

    if (!user) {
      return res.status(401).json({
        success: false,
        message:
          '记住设备凭证已失效，请重新登录',
      });
    }

    await pool.execute(
      `
      UPDATE remember_devices
      SET last_used_at = NOW()
      WHERE id = ?
      `,
      [user.remember_id],
    );

    const sessionToken =
      randomToken();

    const sessionTokenHash =
      hashToken(sessionToken);

    const sessionHours =
      Number(
        process.env.SESSION_TTL_HOURS || 12,
      );

    const sessionExpiresAt =
      addHours(sessionHours);

    await pool.execute(
      `
      INSERT INTO auth_sessions
        (
          user_id,
          token_hash,
          expires_at
        )
      VALUES (?, ?, ?)
      `,
      [
        user.user_id,
        sessionTokenHash,
        sessionExpiresAt,
      ],
    );

    return res.json({
      success: true,
      data: {
        token: sessionToken,
        rememberToken,
        user: publicUser(user),
      },
    });
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


module.exports = router;
