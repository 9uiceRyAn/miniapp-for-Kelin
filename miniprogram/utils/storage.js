const KEYS = {
  TOKEN: 'fileManagerToken',
  USER: 'fileManagerUser',
  REMEMBER_TOKEN: 'fileManagerRememberToken',
  REMEMBER_USERNAME: 'fileManagerRememberUsername',
};

function get(key, fallback = null) {
  try {
    const value = wx.getStorageSync(key);
    return value === '' || value === undefined ? fallback : value;
  } catch (error) {
    console.warn('读取本地存储失败:', key, error);
    return fallback;
  }
}

function set(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch (error) {
    console.warn('写入本地存储失败:', key, error);
  }
}

function remove(key) {
  try {
    wx.removeStorageSync(key);
  } catch (error) {
    console.warn('删除本地存储失败:', key, error);
  }
}

function saveSession(payload) {
  if (payload.token) set(KEYS.TOKEN, payload.token);
  if (payload.user) set(KEYS.USER, payload.user);
  if (payload.rememberToken) set(KEYS.REMEMBER_TOKEN, payload.rememberToken);
}

function clearSession({ keepRememberToken = false } = {}) {
  remove(KEYS.TOKEN);
  remove(KEYS.USER);
  if (!keepRememberToken) remove(KEYS.REMEMBER_TOKEN);
}

module.exports = {
  KEYS,
  get,
  set,
  remove,
  saveSession,
  clearSession,
  getToken: () => get(KEYS.TOKEN, ''),
  getUser: () => get(KEYS.USER, null),
  getRememberToken: () => get(KEYS.REMEMBER_TOKEN, ''),
  getRememberUsername: () => get(KEYS.REMEMBER_USERNAME, ''),
};
