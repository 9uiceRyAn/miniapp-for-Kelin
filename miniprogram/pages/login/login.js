const workspace = require('../../utils/workspace');
const withInputHints = require('../../utils/input-hints');
const api = require('../../utils/api');
const storage = require('../../utils/storage');
const wechat = require('../../utils/wechat.js');

Page(withInputHints({
  ...wechat,
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
    wechatEnabled: false,
    wechatStatus: '正在检查微信登录服务…',
    wechatAvatarPath: '',
    wechatDisplayName: '',
  },

  onResize() { this.setData({ navigationStyle: workspace.navigationStyle(wx) }); },
  onLoad() {
    this.setData({ navigationStyle: workspace.navigationStyle(wx) });
    api.request({ path: '/api/auth/wechat/config', auth: false })
      .then(config => {
        if (this._left) return;
        const wechatEnabled = config?.mini === true;
        this.setData({ wechatEnabled, wechatStatus: wechatEnabled ? '' : '当前服务尚未启用微信登录' });
      })
      .catch(error => {
        if (this._left) return;
        const wechatStatus = error.statusCode === 404
          ? '当前服务尚未启用微信登录'
          : '暂时无法连接微信登录服务';
        this.setData({ wechatStatus });
      });
    const savedUsername = storage.getRememberUsername();
    this.setData({
      username: savedUsername,
      rememberUsername: Boolean(savedUsername),
    });
    this.tryAutoLogin();
  },

  async tryAutoLogin() {
    if (this.data.loading || this.data.autoLoggingIn) return;
    const token = storage.getToken();
    const rememberToken = storage.getRememberToken();

    if (!token && !rememberToken) return;

    this.setData({ autoLoggingIn: true, errorMessage: '' });

    try {
      if (token) {
        const result = await api.me();
        if (this._left) return;
        storage.saveSession({ token, user: result.user });
        wx.reLaunch({ url: '/pages/learning/index?section=agents' });
        return;
      }
    } catch (error) {
      if (this._left) return;
      if (error.statusCode !== 401) {
        this.setData({ autoLoggingIn: false, errorMessage: '暂时无法验证登录状态，请稍后重试' });
        return;
      }
      storage.clearSession({ keepRememberToken: true });
    }

    if (rememberToken) {
      try {
        const result = await api.rememberLogin();
        if (this._left) return;
        storage.saveSession(result);
        wx.reLaunch({ url: '/pages/learning/index?section=agents' });
        return;
      } catch (error) {
        if (this._left) return;
        if (error.statusCode === 401) storage.clearSession();
        else this.setData({ errorMessage: '暂时无法验证已记住的设备，请稍后重试' });
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

  onUsernameFocus(event) {
    this.onInputHintFocus(event);
    this.setData({ focusedField: 'username' });
  },

  onPasswordFocus(event) {
    this.onInputHintFocus(event);
    this.setData({ focusedField: 'password' });
  },

  onInputBlur(event) {
    this.onInputHintBlur(event);
    if (!this.data.inputHintFocus) this.setData({ focusedField: '' });
  },

  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword });
  },

  onUnload() {
    this._left = true;
  },

  changeRememberOptions(event) {
    const values = event.detail.value;
    this.setData({
      rememberUsername: values.includes('username'),
      rememberDevice: values.includes('device'),
    });
  },

  async submitLogin() {
    if (this.data.loading || this.data.autoLoggingIn) return;

    const username = this.data.username.trim();
    const password = this.data.password;

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
      if (this._left) return;

      if (this.data.rememberUsername) {
        storage.set(storage.KEYS.REMEMBER_USERNAME, username);
      } else {
        storage.remove(storage.KEYS.REMEMBER_USERNAME);
      }

      if (!result.rememberToken) {
        storage.remove(storage.KEYS.REMEMBER_TOKEN);
      }

      storage.saveSession(result);

      wx.showToast({ title: '登录成功', icon: 'success' });
      wx.reLaunch({
        url: '/pages/learning/index?section=agents',
        fail: () => this.setData({ loading: false }),
      });
    } catch (error) {
      this.setData({
        password: '',
        loading: false,
        errorMessage: error.message || '登录失败，请检查后端服务',
      });
    }
  },

  goRegister() {
    if (this.data.loading || this.data.autoLoggingIn) return;
    wx.navigateTo({ url: '/pages/register/register' });
  },
}));
