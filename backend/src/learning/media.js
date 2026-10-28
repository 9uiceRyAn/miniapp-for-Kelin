const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { rows, one, fail, hash } = require('./core');
const ROOT = path.resolve(
  process.env.LEARNING_STORAGE_ROOT ||
    path.join(__dirname, '../../uploads/learning'),
);
function absolute(relative) {
  const result = path.resolve(ROOT, relative);
  if (!result.startsWith(ROOT + path.sep)) fail(400, '非法媒体路径');
  return result;
}
async function blob(bytes, extension = '') {
  const digest = hash(bytes);
  const relative = `blobs/${digest.slice(0, 2)}/${digest}${extension.replace(/[^.a-z0-9]/gi, '')}`;
  const file = absolute(relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, bytes, { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return { path: relative, hash: digest };
}
function key() {
  if (!process.env.MEDIA_SIGNING_KEY) fail(503, '尚未配置媒体签名');
  return process.env.MEDIA_SIGNING_KEY;
}
function signature(payload) {
  return crypto.createHmac('sha256', key()).update(payload).digest('hex');
}
function ticket(mediaId, tokenHash) {
  const expires = Math.floor(Date.now() / 1000) + 900;
  const payload = Buffer.from(
    JSON.stringify({ mediaId, session: tokenHash, expires }),
  ).toString('base64url');
  return {
    path: `/api/question-bank/content/${mediaId}?ticket=${payload}.${signature(payload)}`,
    expiresAt: expires * 1000,
  };
}
async function verify(mediaId, value) {
  const [payload, supplied = ''] = String(value || '').split('.');
  const expected = signature(payload || '');
  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  )
    fail(401, '媒体访问凭证无效');
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url'));
  } catch {
    fail(401, '媒体访问凭证无效');
  }
  if (decoded.mediaId !== mediaId || decoded.expires < Date.now() / 1000)
    fail(401, '媒体访问凭证已过期');
  const session = await one(
    'SELECT u.id,u.role FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>NOW() AND u.status=1',
    [decoded.session],
  );
  if (!session) fail(401, '登录已过期');
  const item = await one(
    'SELECT m.*,r.resource_id FROM kl_media m JOIN kl_revisions r ON r.id=m.revision_id WHERE m.id=?',
    [mediaId],
  );
  if (!item) fail(404, '媒体不存在');
  await requireResource(session, item.resource_id);
  if (!item.storage_path) fail(410, '原媒体不可用');
  return item;
}
async function requireResource(user, resourceId) {
  const resource = await one('SELECT * FROM kl_resources WHERE id=?', [
    resourceId,
  ]);
  if (!resource) fail(404, '资料不存在');
  if (resource.visibility === 'withdrawn') fail(410, '资料已撤下');
  if (
    resource.source_file_id &&
    !(await one('SELECT id FROM files WHERE id=?', [resource.source_file_id]))
  )
    fail(410, '原文件已删除');
  if (resource.visibility === 'public') return resource;
  if (String(resource.owner_id) === String(user.id)) return resource;
  const permitted = await one(
    `SELECT a.id FROM kl_assets a JOIN kl_conversations c ON c.id=a.conversation_id JOIN kl_agents g ON g.id=c.agent_id WHERE a.resource_id=? AND c.mode='student' AND g.owner_id=?`,
    [resourceId, user.id],
  );
  if (!permitted) fail(403, '无权读取此资料');
  return resource;
}
async function references(revisionId, sessionHash) {
  const media = await rows(
    'SELECT id,kind,label,mime,storage_path FROM kl_media WHERE revision_id=? ORDER BY position,id',
    [revisionId],
  );
  return media.map((m) => ({
    id: m.id,
    kind: m.kind,
    label: m.label,
    mime: m.mime,
    available: Boolean(m.storage_path),
    ...(m.storage_path ? ticket(m.id, sessionHash) : {}),
  }));
}
const mime = (file) =>
  ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf',
    '.docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain',
  })[path.extname(file).toLowerCase()] || 'application/octet-stream';
module.exports = {
  ROOT,
  absolute,
  blob,
  ticket,
  verify,
  requireResource,
  references,
  mime,
};
