const api = require('./api'),
  storage = require('./storage');
const base = api.API_BASE_URL;
function request(path, method = 'GET', data) {
  return api.request({ path, method, data: data || {} });
}
function query(values) {
  return Object.keys(values)
    .filter(
      (k) => values[k] !== undefined && values[k] !== null && values[k] !== '',
    )
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(values[k]))
    .join('&');
}
function url(path) {
  return path && path.startsWith('/') ? base + path : path;
}
function error(error) {
  if (error.statusCode === 401) {
    storage.clearSession({ keepRememberToken: true });
    wx.reLaunch({ url: '/pages/login/login' });
  } else wx.showToast({ title: error.message || '请求失败', icon: 'none' });
}
function guard() {
  if (!storage.getToken()) {
    wx.reLaunch({ url: '/pages/login/login' });
    return false;
  }
  return true;
}
function go(path) {
  wx.navigateTo({ url: path });
}
function id() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}
function pickFile(images = false) {
  return new Promise((resolve, reject) => {
    wx.showActionSheet({
      itemList: images
        ? ['拍照或相册图片', '微信聊天文件']
        : ['微信聊天文件', '拍照或相册图片'],
      success: (result) => {
        const photo = images ? result.tapIndex === 0 : result.tapIndex === 1;
        if (photo)
          wx.chooseMedia({
            count: 1,
            mediaType: ['image'],
            success: (r) =>
              resolve({ path: r.tempFiles[0].tempFilePath, name: '图片.jpg' }),
            fail: reject,
          });
        else
          wx.chooseMessageFile({
            count: 1,
            type: 'file',
            success: (r) =>
              resolve({ path: r.tempFiles[0].path, name: r.tempFiles[0].name }),
            fail: reject,
          });
      },
      fail: reject,
    });
  });
}
function upload(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      url: base + path,
      filePath: file.path,
      name: 'file',
      formData: { fileName: file.name || '' },
      header: { Authorization: 'Bearer ' + storage.getToken() },
      success: (r) => {
        let body;
        try {
          body = JSON.parse(r.data);
        } catch {
          return reject(new Error('上传响应无效'));
        }
        if (r.statusCode >= 200 && r.statusCode < 300 && body.success)
          resolve(body.data);
        else {
          const e = new Error(body.message || '上传失败');
          e.statusCode = r.statusCode;
          reject(e);
        }
      },
      fail: reject,
    });
    if (onProgress) task.onProgressUpdate((r) => onProgress(r.progress));
  });
}
async function renderMessage(message) {
  if (message.role !== 'assistant') return message;
  const rendered = await request(
    '/api/ai/messages/' + message.id + '/render',
    'POST',
  );
  const replacements = {};
  for (const formula of rendered.formulas) {
    const local = await api.download({
      path: formula.path,
      fileName: formula.hash + '.svg',
    });
    replacements['formula:' + formula.hash] = local.filePath;
  }
  function visit(nodes) {
    return nodes.map((n) => ({
      ...n,
      ...(n.attrs
        ? {
            attrs: {
              ...n.attrs,
              src: replacements[n.attrs.src] || n.attrs.src,
            },
          }
        : {}),
      ...(n.children ? { children: visit(n.children) } : {}),
    }));
  }
  return { ...message, nodes: visit(rendered.nodes) };
}
// Stateful UTF-8 decoding keeps split multibyte characters intact in native chunk callbacks.
function decoder() {
  let pending = [];
  return (buffer) => {
    const bytes = pending.concat(Array.from(new Uint8Array(buffer)));
    let text = '',
      i = 0;
    while (i < bytes.length) {
      const lead = bytes[i],
        length = lead < 128 ? 1 : lead < 224 ? 2 : lead < 240 ? 3 : 4;
      if (i + length > bytes.length) break;
      let value =
        lead & (length === 1 ? 127 : length === 2 ? 31 : length === 3 ? 15 : 7);
      for (let k = 1; k < length; k++)
        value = (value << 6) | (bytes[i + k] & 63);
      text += String.fromCodePoint(value);
      i += length;
    }
    pending = bytes.slice(i);
    return text;
  };
}
function subscribe(runId, after, onEvent, onEnd) {
  let rest = '';
  const decode = decoder();
  const task = wx.request({
    url:
      base +
      '/api/ai/runs/' +
      runId +
      '/events?stream=1&afterSequence=' +
      after,
    enableChunked: true,
    responseType: 'arraybuffer',
    header: { Authorization: 'Bearer ' + storage.getToken() },
    success: (r) =>
      onEnd(r.statusCode === 200 ? null : new Error('事件连接失败')),
    fail: onEnd,
  });
  if (!task.onChunkReceived) {
    task.abort();
    return null;
  }
  task.onChunkReceived(({ data }) => {
    rest += decode(data);
    const lines = rest.split('\n');
    rest = lines.pop();
    for (const line of lines)
      if (line.trim()) {
        try {
          onEvent(JSON.parse(line));
        } catch (e) {
          onEnd(e);
          task.abort();
        }
      }
  });
  return task;
}
function openDocument(doc) {
  go('/pages/question/detail?id=' + doc.resourceId + '&revisionId=' + doc.revisionId + '&document=1');
}
module.exports = {
  openDocument,
  request,
  query,
  url,
  error,
  guard,
  go,
  id,
  pickFile,
  upload,
  renderMessage,
  subscribe,
};
