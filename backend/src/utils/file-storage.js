const path = require('node:path');

const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_ROOT || '/var/www/file-manager/uploads/files');

function storedFilePath(relative) {
  const file = path.resolve(UPLOAD_ROOT, relative);
  if (!file.startsWith(UPLOAD_ROOT + path.sep)) {
    const error = new Error('非法文件存储路径');
    error.status = 400;
    throw error;
  }
  return file;
}

module.exports = { UPLOAD_ROOT, storedFilePath };
