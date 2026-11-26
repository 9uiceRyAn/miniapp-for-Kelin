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
  header = {},
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
      const token = auth ? storage.getToken() : '';
      wx.request({
        url:
          `${API_BASE_URL}${path}`,

        method,

        data,

        header: {
          ...header,
          'Content-Type':
            'application/json',

          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },

        success(res) {
          if (auth && token !== storage.getToken()) {
            reject(makeError('登录会话已切换', 409));
            return;
          }
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


module.exports = {
  API_BASE_URL,
  request,
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

};
