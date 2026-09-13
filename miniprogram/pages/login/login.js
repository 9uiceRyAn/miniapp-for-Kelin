const api = require('../../utils/api');
const storage = require('../../utils/storage');

Page({
  data: {
    username: '',
    password: '',
    showPassword: false,
    rememberUsername: false,
    rememberDevice: true,
    loading: false,
    autoLoggingIn: false,
    errorMessage: '',
    focusedField: '',
  },

  onLoad() {
    const savedUsername = storage.getRememberUsername();
    this.setData({
      username: savedUsername,
      rememberUsername: Boolean(savedUsername),
    });
    this.tryAutoLogin();
  },

  async tryAutoLogin() {
    const token = storage.getToken();
    const rememberToken = storage.getRememberToken();

    if (!token && !rememberToken) return;

    this.setData({ autoLoggingIn: true, errorMessage: '' });

    try {
      if (token) {
        const result = await api.me();
        storage.saveSession({ token, user: result.user });
        getApp().globalData.user = result.user;
        wx.reLaunch({ url: '/pages/home/home' });
        return;
      }
    } catch (error) {
      storage.clearSession({ keepRememberToken: true });
    }

    if (rememberToken) {
      try {
        const result = await api.rememberLogin(rememberToken);
        storage.saveSession({ token: result.token, user: result.user });
        getApp().globalData.user = result.user;
        wx.reLaunch({ url: '/pages/home/home' });
        return;
      } catch (error) {
        storage.clearSession();
      }
    }

    this.setData({ autoLoggingIn: false });
  },

  onUsernameInput(event) {
    this.setData({ username: event.detail.value, errorMessage: '' });
  },

  onPasswordInput(event) {
    this.setData({ password: event.detail.value, errorMessage: '' });
  },

  onUsernameFocus() {
    this.setData({ focusedField: 'username' });
  },

  onPasswordFocus() {
    this.setData({ focusedField: 'password' });
  },

  onInputBlur() {
    this.setData({ focusedField: '' });
  },

  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword });
  },

  toggleRememberUsername() {
    this.setData({ rememberUsername: !this.data.rememberUsername });
  },

  toggleRememberDevice() {
    this.setData({ rememberDevice: !this.data.rememberDevice });
  },

  async submitLogin() {
    if (this.data.loading || this.data.autoLoggingIn) return;

    const username = String(this.data.username || '').trim();
    const password = String(this.data.password || '');

    if (!username) {
      this.setData({ errorMessage: '请输入用户名' });
      return;
    }
    if (!password) {
      this.setData({ errorMessage: '请输入密码' });
      return;
    }

    this.setData({ loading: true, errorMessage: '' });

    try {
      const result = await api.login({
        username,
        password,
        rememberDevice: this.data.rememberDevice,
      });

      if (this.data.rememberUsername) {
        storage.set(storage.KEYS.REMEMBER_USERNAME, username);
      } else {
        storage.remove(storage.KEYS.REMEMBER_USERNAME);
      }

      if (!this.data.rememberDevice) {
        storage.remove(storage.KEYS.REMEMBER_TOKEN);
      }

      storage.saveSession(result);
      getApp().globalData.user = result.user;

      wx.showToast({ title: '登录成功', icon: 'success' });
      setTimeout(() => wx.reLaunch({ url: '/pages/home/home' }), 350);
    } catch (error) {
      this.setData({
        password: '',
        errorMessage: error.message || '登录失败，请检查后端服务',
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  goRegister() {
    wx.navigateTo({ url: '/pages/register/register' });
  },
});
