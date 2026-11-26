const api = require('./api'),
  storage = require('./storage');
const base = api.API_BASE_URL;
const MANAGEMENT_TOKEN_KEY = 'kl_management_token';
const MANAGEMENT_EXPIRES_KEY = 'kl_management_expires';
let memoryManagementToken = '';
let memoryManagementExpires = 0;

function getManagementToken() {
  if (!memoryManagementToken) {
    memoryManagementToken = wx.getStorageSync(MANAGEMENT_TOKEN_KEY) || '';
    memoryManagementExpires = Number(wx.getStorageSync(MANAGEMENT_EXPIRES_KEY) || 0);
  }
  if (!memoryManagementToken) return '';
  if (Date.now() >= memoryManagementExpires) {
    clearManagementToken();
    return '';
  }
  return memoryManagementToken;
}

function setManagementToken(token, expiresAt) {
  memoryManagementToken = token || '';
  memoryManagementExpires = Number(expiresAt || 0);
  if (memoryManagementToken) {
    wx.setStorageSync(MANAGEMENT_TOKEN_KEY, memoryManagementToken);
    wx.setStorageSync(MANAGEMENT_EXPIRES_KEY, memoryManagementExpires);
  }
}

function clearManagementToken() {
  memoryManagementToken = '';
  memoryManagementExpires = 0;
  try {
    wx.removeStorageSync(MANAGEMENT_TOKEN_KEY);
    wx.removeStorageSync(MANAGEMENT_EXPIRES_KEY);
  } catch {}
  const cache = require('./cache');
  cache.invalidate('admin:');
  cache.invalidate('accounts:');
  cache.invalidate('usage:admin');
}

async function managementRequest(path, method = 'GET', data = {}) {
  const token = getManagementToken();
  try {
    return await api.request({
      path,
      method,
      data,
      header: token ? { 'X-Management-Token': token } : {},
    });
  } catch (err) {
    if (err.statusCode === 403) clearManagementToken();
    throw err;
  }
}

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
function isDesktop() {
  try {
    const info = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : {};
    const platform = String(info.platform || '').toLowerCase();
    return platform.includes('windows') || platform.includes('mac');
  } catch {
    return false;
  }
}
function imageExtension(filePath) {
  const match = String(filePath || '').match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return match ? '.' + match[1].toLowerCase() : '.jpg';
}
function pickFiles(images = false) {
  if (isDesktop()) {
    return new Promise((resolve, reject) => {
      wx.chooseMessageFile({
        count: 9,
        type: 'all',
        success: (r) =>
          resolve(
            (r.tempFiles || []).map((f) => ({
              path: f.path,
              name: f.name || '未命名文件',
            })),
          ),
        fail: reject,
      });
    });
  }
  return new Promise((resolve, reject) => {
    wx.showActionSheet({
      itemList: images
        ? ['拍照或相册图片', '微信聊天文件']
        : ['微信聊天文件', '拍照或相册图片'],
      success: (result) => {
        const photo = images ? result.tapIndex === 0 : result.tapIndex === 1;
        if (photo)
          wx.chooseMedia({
            count: 9,
            mediaType: ['image'],
            success: (r) =>
              resolve(
                (r.tempFiles || []).map((f, i) => ({
                  path: f.tempFilePath,
                  name: '图片_' + (i + 1) + imageExtension(f.tempFilePath),
                })),
              ),
            fail: reject,
          });
        else
          wx.chooseMessageFile({
            count: 9,
            type: 'all',
            success: (r) =>
              resolve(
                (r.tempFiles || []).map((f) => ({
                  path: f.path,
                  name: f.name || '未命名文件',
                })),
              ),
            fail: reject,
          });
      },
      fail: reject,
    });
  });
}
async function pickFile(images = false) {
  const files = await pickFiles(images);
  if (!files || !files.length) throw new Error('未选择文件');
  return files[0];
}
function uploadFile(path, filePath, formData = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      url: base + path,
      filePath,
      name: 'file',
      formData,
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
function upload(path, file, onProgress) {
  return uploadFile(path, file.path, { fileName: file.name || '' }, onProgress);
}
function confirm(content, options = {}) {
  return new Promise((resolve) => {
    wx.showModal({
      title: options.title || '提示',
      content,
      confirmText: options.confirmText || '确认',
      cancelText: options.cancelText || '取消',
      ...(options.confirmColor ? { confirmColor: options.confirmColor } : {}),
      success: (res) => resolve(Boolean(res.confirm)),
      fail: () => resolve(false),
    });
  });
}
function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
async function getMe(onData) {
  const cache = require('./cache');
  const cached = cache.get('me', { maxAge: 5 * 60 * 1000 });
  if (cached) {
    onData(cached.value);
    if (!cached.fresh) {
      request('/api/ai/me')
        .then((me) => {
          cache.set('me', me, { persist: true });
          onData(me);
        })
        .catch(() => {});
    }
    return cached.value;
  }
  const me = await request('/api/ai/me');
  cache.set('me', me, { persist: true });
  onData(me);
  return me;
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
module.exports = {
  request,
  managementRequest,
  getManagementToken,
  setManagementToken,
  clearManagementToken,
  getMe,
  confirm,
  formatBytes,
  isDesktop,
  query,
  url,
  error,
  guard,
  go,
  id,
  pickFile,
  pickFiles,
  uploadFile,
  upload,
  subscribe,
};
