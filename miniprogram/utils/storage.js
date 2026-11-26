const KEYS = {
  TOKEN: 'fileManagerToken',
  USER: 'fileManagerUser',
  REMEMBER_TOKEN: 'fileManagerRememberToken',
  REMEMBER_USERNAME: 'fileManagerRememberUsername',
};

function get(key, fallback = null) {
  if (typeof wx === 'undefined') return fallback;
  try {
    const value = wx.getStorageSync(key);
    return value === '' || value === undefined ? fallback : value;
  } catch (error) {
    console.warn('读取本地存储失败:', key, error);
    return fallback;
  }
}

function set(key, value) {
  if (typeof wx === 'undefined') return;
  try {
    wx.setStorageSync(key, value);
  } catch (error) {
    console.warn('写入本地存储失败:', key, error);
  }
}

function remove(key) {
  if (typeof wx === 'undefined') return;
  try {
    wx.removeStorageSync(key);
  } catch (error) {
    console.warn('删除本地存储失败:', key, error);
  }
}

function saveSession(payload) {
  if (payload.token) set(KEYS.TOKEN, payload.token);
  if (payload.user) {
    const prevUser = get(KEYS.USER, null);
    if (prevUser && prevUser.id != null && payload.user.id != null && String(prevUser.id) !== String(payload.user.id)) {
      require('./cache').clear();
      require('./learning').clearManagementToken();
    }
    set(KEYS.USER, payload.user);
  }
  if (payload.rememberToken) set(KEYS.REMEMBER_TOKEN, payload.rememberToken);
}

function clearSession({ keepRememberToken = false } = {}) {
  require('./learning').clearManagementToken();
  require('./cache').clear();
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
