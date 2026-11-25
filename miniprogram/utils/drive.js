const storage = require('./storage');
const { API_BASE_URL } = require('../config/api');

const DOC_TYPES = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf']);
const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const VIDEO_TYPES = new Set(['mp4', 'mov', 'm4v']);
const AUDIO_TYPES = new Set(['mp3', 'm4a', 'wav', 'aac']);

function isDesktop() {
  try {
    const info = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : {};
    const platform = String(info.platform || '').toLowerCase();
    return platform.includes('windows') || platform.includes('mac');
  } catch {
    return false;
  }
}

function chooseUploadFiles() {
  if (isDesktop()) {
    return new Promise((resolve, reject) => {
      wx.chooseMessageFile({
        count: 9,
        type: 'all',
        success: res => resolve((res.tempFiles || []).map(f => ({ path: f.path, name: f.name || '未命名文件' }))),
        fail: reject,
      });
    });
  }
  return new Promise((resolve, reject) => {
    wx.showActionSheet({
      itemList: ['相册图片或视频', '拍照或录像', '微信聊天文件'],
      success: ({ tapIndex }) => {
        if (tapIndex === 0 || tapIndex === 1) {
          wx.chooseMedia({
            count: tapIndex === 0 ? 9 : 1,
            mediaType: ['image', 'video'],
            sourceType: [tapIndex === 0 ? 'album' : 'camera'],
            success: res => resolve((res.tempFiles || []).map((f, i) => ({
              path: f.tempFilePath,
              name: (f.fileType === 'video' ? '视频_' : '图片_') + (i + 1) + (f.fileType === 'video' ? '.mp4' : '.jpg'),
            }))),
            fail: reject,
          });
        } else {
          wx.chooseMessageFile({
            count: 9,
            type: 'all',
            success: res => resolve((res.tempFiles || []).map(f => ({ path: f.path, name: f.name || '未命名文件' }))),
            fail: reject,
          });
        }
      },
      fail: reject,
    });
  });
}

function uploadFile(folderId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      url: API_BASE_URL + '/api/drive/files/upload',
      filePath: file.path,
      name: 'file',
      formData: {
        ...(folderId ? { folderId: String(folderId) } : {}),
        clientFileName: file.name || '',
      },
      header: { Authorization: 'Bearer ' + storage.getToken() },
      success: res => {
        let body;
        try { body = JSON.parse(res.data); } catch { return reject(new Error('上传响应无效')); }
        if (res.statusCode >= 200 && res.statusCode < 300 && body.success) resolve(body.data);
        else reject(new Error(body.message || '上传失败'));
      },
      fail: reject,
    });
    if (onProgress) task.onProgressUpdate(p => onProgress(p.progress));
  });
}

function downloadTemp(apiPath, onProgress) {
  return new Promise((resolve, reject) => {
    const task = wx.downloadFile({
      url: API_BASE_URL + apiPath,
      header: { Authorization: 'Bearer ' + storage.getToken() },
      success: res => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.tempFilePath) resolve(res.tempFilePath);
        else reject(new Error('下载失败（' + res.statusCode + '）'));
      },
      fail: reject,
    });
    if (onProgress) task.onProgressUpdate(p => onProgress(p.progress));
  });
}

async function previewFile(file) {
  const ext = String(file.file_type || '').toLowerCase();
  wx.showLoading({ title: '正在加载', mask: true });
  try {
    const filePath = await downloadTemp('/api/drive/files/' + file.id + '/download');
    wx.hideLoading();
    if (IMAGE_TYPES.has(ext)) {
      wx.previewImage({ current: filePath, urls: [filePath] });
    } else if (VIDEO_TYPES.has(ext)) {
      wx.previewMedia({ sources: [{ url: filePath, type: 'video' }] });
    } else if (DOC_TYPES.has(ext)) {
      wx.openDocument({ filePath, fileType: ext, showMenu: true });
    } else if (AUDIO_TYPES.has(ext)) {
      const audio = wx.createInnerAudioContext();
      audio.src = filePath;
      audio.play();
      wx.showToast({ title: '正在播放音频', icon: 'none' });
    } else {
      await saveOrShareTemp(filePath, file.original_name);
    }
  } catch (e) {
    wx.hideLoading();
    wx.showToast({ title: e.message || '无法打开文件', icon: 'none' });
  }
}

function saveOrShareTemp(filePath, fileName) {
  if (isDesktop()) {
    return new Promise((resolve, reject) => {
      wx.saveFileToDisk({
        filePath,
        success: () => { wx.showToast({ title: '已保存到本地' }); resolve(); },
        fail: err => {
          if (String(err.errMsg || '').includes('cancel')) return resolve();
          reject(new Error('保存失败'));
        },
      });
    });
  }
  return new Promise((resolve, reject) => {
    wx.shareFileMessage({
      filePath,
      fileName: fileName || '资料文件',
      success: resolve,
      fail: err => {
        if (String(err.errMsg || '').includes('cancel')) return resolve();
        reject(new Error('转发失败'));
      },
    });
  });
}

async function downloadAndSave(apiPath, fileName) {
  wx.showLoading({ title: '正在准备文件', mask: true });
  try {
    const filePath = await downloadTemp(apiPath);
    wx.hideLoading();
    await saveOrShareTemp(filePath, fileName);
  } catch (e) {
    wx.hideLoading();
    wx.showToast({ title: e.message || '下载失败', icon: 'none' });
  }
}

function formatSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

module.exports = {
  isDesktop,
  chooseUploadFiles,
  uploadFile,
  previewFile,
  downloadAndSave,
  formatSize,
};
