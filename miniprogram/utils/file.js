const DOCUMENT_TYPES = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
]);
const IMAGE_TYPES = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);

function getExtension(name) {
  const value = String(name || '');
  const index = value.lastIndexOf('.');
  return index >= 0 ? value.slice(index + 1).toLowerCase() : '';
}

function sanitizeFileName(name) {
  const value = String(name || '未命名文件')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim();
  return value.slice(0, 180) || '未命名文件';
}

function uniqueUserDataPath(fileName) {
  const safeName = sanitizeFileName(fileName);
  const ext = getExtension(safeName);
  const base = ext ? safeName.slice(0, -(ext.length + 1)) : safeName;
  const suffix = `${Date.now()}`;
  return `${wx.env.USER_DATA_PATH}/${base}_${suffix}${ext ? `.${ext}` : ''}`;
}

function copyToUserData(tempFilePath, fileName) {
  return new Promise((resolve, reject) => {
    const targetPath = uniqueUserDataPath(fileName);
    wx.getFileSystemManager().copyFile({
      srcPath: tempFilePath,
      destPath: targetPath,
      success: () => resolve(targetPath),
      fail: reject,
    });
  });
}

function shareFile(filePath, fileName) {
  if (typeof wx.shareFileMessage !== 'function') {
    wx.showModal({
      title: '文件已下载',
      content: `文件已保存在小程序本地目录：\n${filePath}`,
      showCancel: false,
    });
    return Promise.resolve({ action: 'save', path: filePath });
  }

  return new Promise((resolve, reject) => {
    wx.shareFileMessage({
      filePath,
      fileName: sanitizeFileName(fileName),
      success: () => resolve({ action: 'share', path: filePath }),
      fail: reject,
    });
  });
}

function previewOrShare(tempFilePath, fileName) {
  const ext = getExtension(fileName);

  return copyToUserData(tempFilePath, fileName).then((namedPath) => {
    if (IMAGE_TYPES.has(ext)) {
      wx.previewImage({ urls: [namedPath], current: namedPath });
      return { action: 'preview', path: namedPath };
    }

    if (DOCUMENT_TYPES.has(ext)) {
      return new Promise((resolve) => {
        wx.openDocument({
          filePath: namedPath,
          fileType: ext,
          showMenu: true,
          success: () => resolve({ action: 'open', path: namedPath }),
          fail: async () => {
            try {
              resolve(await shareFile(namedPath, fileName));
            } catch (error) {
              wx.showModal({
                title: '文件已下载',
                content: `当前设备无法直接预览或分享此文件。文件位置：\n${namedPath}`,
                showCancel: false,
              });
              resolve({ action: 'save', path: namedPath });
            }
          },
        });
      });
    }

    return shareFile(namedPath, fileName).catch(() => {
      wx.showModal({
        title: '文件已下载',
        content: `文件已保存在小程序本地目录：\n${namedPath}`,
        showCancel: false,
      });
      return { action: 'save', path: namedPath };
    });
  });
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 文件时间统一按照北京时间（UTC+8）显示。
 *
 * 例如：
 * 2026-09-07T06:19:01.000Z
 *
 * 显示为：
 * 2026/09/07 2:19 PM
 */
function formatDate(value) {
  if (!value) {
    return '-';
  }

  const raw = String(value).trim();

  const timestamp = Date.parse(raw);

  if (Number.isNaN(timestamp)) {
    return raw;
  }

  const BEIJING_OFFSET =
    8 * 60 * 60 * 1000;

  const beijingDate =
    new Date(
      timestamp + BEIJING_OFFSET,
    );

  const pad = (number) =>
    String(number).padStart(2, '0');

  const year =
    beijingDate.getUTCFullYear();

  const month =
    pad(
      beijingDate.getUTCMonth() + 1,
    );

  const day =
    pad(
      beijingDate.getUTCDate(),
    );

  const hour24 =
    beijingDate.getUTCHours();

  const minute =
    pad(
      beijingDate.getUTCMinutes(),
    );

  const period =
    hour24 >= 12
      ? 'PM'
      : 'AM';

  const hour12 =
    hour24 % 12 || 12;

  return (
    `${year}/${month}/${day} ` +
    `${hour12}:${minute} ${period}`
  );
}

function readableType(file) {
  const ext = getExtension(file.original_name);
  return ext ? ext.toUpperCase() : String(file.mime_type || 'FILE').split('/').pop().toUpperCase();
}

function iconType(fileName) {
  const ext = getExtension(fileName);
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_TYPES.has(ext)) return 'image';
  if (['doc', 'docx'].includes(ext)) return 'word';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'sheet';
  if (['ppt', 'pptx'].includes(ext)) return 'ppt';
  if (['zip', 'rar', '7z'].includes(ext)) return 'zip';
  return 'file';
}

function todayText() {
  const date = new Date();
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

module.exports = {
  getExtension,
  sanitizeFileName,
  copyToUserData,
  previewOrShare,
  formatFileSize,
  formatDate,
  readableType,
  iconType,
  todayText,
};
