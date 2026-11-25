const fs = require('node:fs/promises');
const core = require('./core');
const media = require('./media');
const documents = require('./documents');
const pending = new Map();

async function recognize(question, image, modelId, bytes, context) {
  const ids = [question.revisionId, image.id, modelId];
  const cached = await core.one('SELECT body FROM kl_question_image_text WHERE revision_id=? AND media_id=? AND model_id=?', ids);
  if (cached) return cached.body;
  const key = ids.join('/');
  if (!pending.has(key)) {
    const work = async () => {
      const body = await documents.vision(bytes, image.mime, context, modelId);
      if (!body.trim()) core.fail(502, '视觉模型返回空内容');
      await core.rows('INSERT IGNORE INTO kl_question_image_text(revision_id,media_id,model_id,body) VALUES(?,?,?,?)', [...ids, body]);
      return body;
    };
    pending.set(key, work().finally(() => pending.delete(key)));
  }
  return pending.get(key);
}

async function prepare(question, model, visionModelId, context) {
  const images = await core.rows(
    "SELECT id,mime,label,storage_path FROM kl_media WHERE revision_id=? AND mime LIKE 'image/%' AND kind NOT IN ('answer','ms','sm') ORDER BY position,id",
    [question.revisionId],
  );
  const stem = String(question.question_text || '').trim();
  if (!images.length && !stem) core.fail(422, question.title + '：此修订缺少可读题面');
  const parts = stem ? [{ type: 'text', text: stem }] : [];
  for (const [index, image] of images.entries()) {
    const label = question.title + ' · 题面第 ' + (index + 1) + ' 页';
    if (!image.storage_path) core.fail(422, label + '：图片缺失');
    let bytes;
    try { bytes = await fs.readFile(media.absolute(image.storage_path)); }
    catch { core.fail(422, label + '：图片读取失败'); }
    if (!bytes.length) core.fail(422, label + '：图片为空');
    if (model.capabilities?.vision && model.capabilities.verified?.vision) {
      parts.push({ type: 'text', text: label }, { type: 'image', image: 'data:' + image.mime + ';base64,' + bytes.toString('base64'), mediaType: image.mime });
    } else {
      if (!visionModelId) core.fail(503, label + '：请先在 API 管理配置已验证的视觉模型');
      try {
        const text = await recognize(question, image, visionModelId, bytes, context);
        parts.push({ type: 'text', text: label + '\n' + text });
      } catch (error) { core.fail(502, label + '：' + (error.status ? error.message : '图片识别失败，请重试')); }
    }
  }
  return parts;
}
module.exports = { prepare };
