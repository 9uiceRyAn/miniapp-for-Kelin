const storage = require('./storage');
const { API_BASE_URL } = require('../config/api');
const { isDesktop, uploadFile: uploadRaw, formatBytes: formatSize } = require('./learning');

const DOC_TYPES = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf']);
const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const VIDEO_TYPES = new Set(['mp4', 'mov', 'm4v']);
const AUDIO_TYPES = new Set(['mp3', 'm4a', 'wav', 'aac']);
const TEXT_TYPES = new Set(['md', 'markdown', 'txt', 'json', 'csv', 'log', 'xml', 'yml', 'yaml', 'html', 'css', 'js', 'ts', 'py', 'sql']);
const MAX_TEXT_PREVIEW_CHARS = 100000;

function isDevtools() {
  try {
    const info = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : {};
    return String(info.platform || '').toLowerCase().includes('devtools');
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
  return uploadRaw(
    '/api/drive/files/upload',
    file.path,
    {
      ...(folderId ? { folderId: String(folderId) } : {}),
      clientFileName: file.name || '',
    },
    onProgress,
  );
}

function resolveFileExt(file) {
  const fromType = String(file?.file_type || '').trim().toLowerCase().replace(/^\./, '');
  if (fromType) return fromType;
  const name = String(file?.original_name || '').trim();
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

function sanitizeFileName(name) {
  const cleaned = String(name || '').replace(/[/\\:*?"<>|]/g, '_').trim();
  return cleaned || '资料文件';
}

function downloadTemp(apiPath) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: API_BASE_URL + apiPath,
      header: { Authorization: 'Bearer ' + storage.getToken() },
      success: res => {
        const resolved = res.filePath || res.tempFilePath;
        if (res.statusCode >= 200 && res.statusCode < 300 && resolved) resolve(resolved);
        else reject(new Error('下载失败（' + res.statusCode + '）'));
      },
      fail: reject,
    });
  });
}

function readTextFile(filePath) {
  return new Promise((resolve, reject) => {
    if (typeof wx.getFileSystemManager !== 'function') {
      return reject(new Error('当前环境不支持读取文本内容'));
    }
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'utf8',
      success: res => {
        const text = String(res.data || '');
        if (text.length > MAX_TEXT_PREVIEW_CHARS) {
          resolve(text.slice(0, MAX_TEXT_PREVIEW_CHARS) + '\n\n…（文件内容较长，已截断显示，可点击下方保存/转发查看完整文件）');
        } else {
          resolve(text);
        }
      },
      fail: err => reject(new Error(err?.errMsg || '读取文件失败')),
    });
  });
}

async function previewFile(file, options = {}) {
  const ext = resolveFileExt(file);
  wx.showLoading({ title: '正在加载', mask: true });
  try {
    const filePath = await downloadTemp('/api/drive/files/' + file.id + '/download');
    wx.hideLoading();
    if (TEXT_TYPES.has(ext) && typeof options.onTextPreview === 'function') {
      const content = await readTextFile(filePath);
      options.onTextPreview({ title: file.original_name || '文本预览', content, file, ext, isMarkdown: ext === 'md' || ext === 'markdown' });
    } else if (IMAGE_TYPES.has(ext)) {
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

function saveToDisk(filePath) {
  return new Promise((resolve, reject) => {
    wx.saveFileToDisk({
      filePath,
      success: () => { wx.showToast({ title: '已保存到本地' }); resolve(); },
      fail: err => {
        if (String(err?.errMsg || '').includes('cancel')) return resolve();
        console.warn('[drive] saveFileToDisk fail:', err);
        reject(new Error('保存失败'));
      },
    });
  });
}

function shareFileOnce(filePath, fileName) {
  return new Promise((resolve, reject) => {
    wx.shareFileMessage({
      filePath,
      fileName: fileName || '资料文件',
      success: resolve,
      fail: err => {
        if (String(err?.errMsg || '').includes('cancel')) return resolve();
        reject(err);
      },
    });
  });
}

async function saveOrShareTemp(filePath, fileName) {
  if (isDesktop()) {
    const fs = wx.getFileSystemManager();
    const dir = wx.env.USER_DATA_PATH + '/drive_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const name = sanitizeFileName(fileName);
    const namedPath = dir + '/' + (name === '.' || name === '..' ? '资料文件' : name);
    fs.mkdirSync(dir);
    try {
      try { fs.copyFileSync(filePath, namedPath); }
      catch { return await saveToDisk(filePath); }
      await saveToDisk(namedPath);
    } finally {
      try { fs.unlinkSync(namedPath); } catch {}
      try { fs.rmdirSync(dir); } catch {}
    }
    return;
  }
  if (isDevtools()) {
    if (typeof wx.saveFileToDisk === 'function') {
      try {
        await saveToDisk(filePath);
        return;
      } catch {}
    }
    await new Promise(resolve => {
      wx.showModal({
        title: '开发者工具暂不支持转发',
        content: '微信开发者工具模拟器不支持文件转发（wx.shareFileMessage），文件已下载完成，请在真机调试或微信客户端中测试。',
        showCancel: false,
        complete: resolve,
      });
    });
    return;
  }
  try {
    await shareFileOnce(filePath, fileName);
  } catch (firstErr) {
    console.warn('[drive] shareFileMessage first attempt fail:', firstErr);
    await new Promise((resolve, reject) => {
      wx.showModal({
        title: '文件已准备就绪',
        content: '点击「立即转发」发送「' + (fileName || '资料文件') + '」',
        confirmText: '立即转发',
        success: res => {
          if (!res.confirm) return resolve();
          wx.shareFileMessage({
            filePath,
            fileName: fileName || '资料文件',
            success: resolve,
            fail: err => {
              if (String(err?.errMsg || '').includes('cancel')) return resolve();
              console.warn('[drive] shareFileMessage fail:', err);
              reject(new Error('转发失败'));
            },
          });
        },
        fail: err => {
          console.warn('[drive] showModal fail:', err);
          reject(new Error('转发失败'));
        },
      });
    });
  }
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

module.exports = {
  isDesktop,
  chooseUploadFiles,
  uploadFile,
  previewFile,
  downloadAndSave,
  formatSize,
};
