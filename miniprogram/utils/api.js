const storage = require('./storage');
const {
  API_BASE_URL,
} = require('../config/api');


function makeError(
  message,
  statusCode,
  payload,
) {
  const error = new Error(
    message || '服务器请求失败',
  );

  error.statusCode =
    Number(statusCode || 500);

  error.payload = payload;

  return error;
}


function authHeader() {
  const token =
    storage.getToken();

  if (!token) {
    return {};
  }

  return {
    Authorization:
      `Bearer ${token}`,
  };
}


function request({
  path,
  method = 'GET',
  data = {},
  auth = true,
  showLoading = false,
  loadingText = '加载中',
}) {
  if (showLoading) {
    wx.showLoading({
      title: loadingText,
      mask: true,
    });
  }

  return new Promise(
    (resolve, reject) => {
      wx.request({
        url:
          `${API_BASE_URL}${path}`,

        method,

        data,

        header: {
          'Content-Type':
            'application/json',

          ...(auth
            ? authHeader()
            : {}),
        },

        success(res) {
          const statusCode =
            Number(
              res.statusCode || 500,
            );

          const body =
            res.data || {};

          if (
            statusCode >= 200 &&
            statusCode < 300 &&
            body.success
          ) {
            resolve(body.data);
            return;
          }

          reject(
            makeError(
              body.message ||
                `请求失败，状态码：${statusCode}`,
              statusCode,
              body,
            ),
          );
        },

        fail(error) {
          console.error(
            'wx.request 失败：',
            error,
          );

          reject(
            makeError(
              error.errMsg ||
                '无法连接服务器',
              500,
              error,
            ),
          );
        },

        complete() {
          if (showLoading) {
            wx.hideLoading();
          }
        },
      });
    },
  );
}


function uploadOne({
  category,
  filePath,
  fileName,
  fileSize = 0,
  onProgress,
}) {
  return new Promise(
    (resolve, reject) => {
      const task =
        wx.uploadFile({
          url:
            `${API_BASE_URL}/api/files/upload`,

          filePath,

          name: 'file',

          header: authHeader(),

          formData: {
            category:
              String(category || ''),

            clientFileName:
              fileName ||
              '未命名文件',

            clientFileSize:
              String(
                Number(
                  fileSize || 0,
                ),
              ),
          },

          success(result) {
            const statusCode =
              Number(
                result.statusCode ||
                500,
              );

            let body = {};

            try {
              body =
                typeof result.data ===
                'string'
                  ? JSON.parse(
                      result.data,
                    )
                  : result.data || {};
            } catch (error) {
              reject(
                makeError(
                  '服务器返回了无法解析的数据',
                  statusCode,
                  result.data,
                ),
              );
              return;
            }

            if (
              statusCode >= 200 &&
              statusCode < 300 &&
              body.success
            ) {
              resolve(body.data);
              return;
            }

            reject(
              makeError(
                body.message ||
                  `上传失败，状态码：${statusCode}`,
                statusCode,
                body,
              ),
            );
          },

          fail(error) {
            console.error(
              'wx.uploadFile 失败：',
              error,
            );

            reject(
              makeError(
                error.errMsg ||
                  '上传文件失败',
                500,
                error,
              ),
            );
          },
        });

      if (
        typeof onProgress ===
          'function' &&
        task &&
        task.onProgressUpdate
      ) {
        task.onProgressUpdate(
          (result) => {
            onProgress(
              Number(
                result.progress || 0,
              ),
            );
          },
        );
      }
    },
  );
}


function download({
  path,
  fileName,
  onProgress,
}) {
  const url =
    `${API_BASE_URL}${path}`;

  return new Promise(
    (resolve, reject) => {
      const task =
        wx.downloadFile({
          url,

          header: authHeader(),

          success(result) {
            const statusCode =
              Number(
                result.statusCode ||
                500,
              );

            if (
              statusCode >= 200 &&
              statusCode < 300 &&
              result.tempFilePath
            ) {
              resolve({
                tempFilePath:
                  result.tempFilePath,

                filePath:
                  result.tempFilePath,

                fileName,
              });

              return;
            }

            reject(
              makeError(
                `下载失败，状态码：${statusCode}`,
                statusCode,
                result,
              ),
            );
          },

          fail(error) {
            console.error(
              'wx.downloadFile 失败：',
              error,
            );

            reject(
              makeError(
                error.errMsg ||
                  '下载文件失败',
                500,
                error,
              ),
            );
          },
        });

      if (
        typeof onProgress ===
          'function' &&
        task &&
        task.onProgressUpdate
      ) {
        task.onProgressUpdate(
          (result) => {
            onProgress(
              Number(
                result.progress || 0,
              ),
            );
          },
        );
      }
    },
  );
}


/*
 * 保留旧名字，防止其他代码
 * 仍然引用 api.callCloud。
 */
function callCloud(
  action,
  data = {},
  options = {},
) {
  switch (action) {
    case 'login':
      return request({
        path:
          '/api/auth/login',
        method: 'POST',
        data,
        auth: false,
        ...options,
      });

    case 'register':
      return request({
        path:
          '/api/auth/register',
        method: 'POST',
        data,
        auth: false,
        ...options,
      });

    case 'me':
      return request({
        path:
          '/api/auth/me',
        ...options,
      });

    case 'logout':
      return request({
        path:
          '/api/auth/logout',
        method: 'POST',
        ...options,
      });

    case 'counts':
      return request({
        path:
          '/api/files/counts',
        ...options,
      });

    case 'listFiles':
      return request({
        path:
          `/api/files?category=${
            encodeURIComponent(
              data.category || '',
            )
          }`,
        ...options,
      });

    case 'deleteFile':
      return request({
        path:
          `/api/files/${
            encodeURIComponent(
              data.id,
            )
          }`,
        method: 'DELETE',
        ...options,
      });

    default:
      return Promise.reject(
        makeError(
          `不支持的旧接口：${action}`,
          400,
        ),
      );
  }
}


module.exports = {
  API_BASE_URL,
  request,
  callCloud,
  uploadOne,
  download,

  login(data) {
    return request({
      path:
        '/api/auth/login',
      method: 'POST',
      data,
      auth: false,
    });
  },

  register(data) {
    return request({
      path:
        '/api/auth/register',
      method: 'POST',
      data,
      auth: false,
    });
  },

  rememberLogin() {
    const rememberToken =
      storage.getRememberToken();

    if (!rememberToken) {
      return Promise.reject(
        makeError(
          '没有可用的记住设备凭证',
          401,
        ),
      );
    }

    return request({
      path:
        '/api/auth/remember-login',
      method: 'POST',
      auth: false,

      data: {
        rememberToken,
      },
    });
  },

  me() {
    return request({
      path:
        '/api/auth/me',
    });
  },

  logout(rememberToken = '') {
    return request({
      path:
        '/api/auth/logout',
      method: 'POST',
      data: {
        rememberToken,
      },
    });
  },

  counts() {
    return request({
      path:
        '/api/files/counts',
    });
  },

  files(category) {
    return request({
      path:
        `/api/files?category=${
          encodeURIComponent(
            category,
          )
        }`,
    });
  },

  marks(category) {
    return request({
      path:
        `/api/marks?category=${
          encodeURIComponent(
            category,
          )
        }`,
    });
  },

  setMarked(id, marked) {
    return request({
      path:
        `/api/marks/${
          encodeURIComponent(id)
        }`,
      method: marked
        ? 'PUT'
        : 'DELETE',
    });
  },

  deleteFile(id) {
    return request({
      path:
        `/api/files/${
          encodeURIComponent(id)
        }`,
      method: 'DELETE',
    });
  },
};