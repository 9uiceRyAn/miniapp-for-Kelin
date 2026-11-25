const { pool } = require('../db');
const { hashToken } = require('../utils/security');

async function requireAuth(req, res, next) {
  try {
    const authorization = String(req.headers.authorization || '');

    if (!authorization.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: '未登录或登录已过期',
      });
    }

    const token = authorization.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        message: '无效的登录凭证',
      });
    }

    const tokenHash = hashToken(token);

    const [rows] = await pool.execute(
      `
      SELECT
        u.id,
        u.username,
        u.display_name,
        u.role,
        u.status
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
        AND s.expires_at > NOW()
        AND u.status = 1
      LIMIT 1
      `,
      [tokenHash],
    );

    if (!rows.length) {
      return res.status(401).json({
        success: false,
        message: '登录已过期，请重新登录',
      });
    }

    req.user = rows[0];
    req.authTokenHash = tokenHash;

    return next();
  } catch (error) {
    console.error('requireAuth error:', error);

    return res.status(500).json({
      success: false,
      message: '身份验证失败',
    });
  }
}

function requireTeacher(req, res, next) {
  if (!req.user || req.user.role !== 'teacher') {
    return res.status(403).json({
      success: false,
      message: '只有教师账号可以执行此操作',
    });
  }

  return next();
}

module.exports = {
  requireAuth,
  requireTeacher,
};
