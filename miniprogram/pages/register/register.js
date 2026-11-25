const workspace = require('../../utils/workspace');
const withInputHints = require('../../utils/input-hints');
const api = require('../../utils/api');
const storage = require('../../utils/storage');

Page(withInputHints({
  onResize() { this.setData({ navigationStyle: workspace.navigationStyle(wx) }); },
  onLoad() {
    this.setData({ navigationStyle: workspace.navigationStyle(wx) });},
  data: {
    role: 'student',
    username: '',
    displayName: '',
    password: '',
    confirmPassword: '',
    registerCode: '',
    loading: false,
    errorMessage: '',
  },

  selectRole(event) {
    this.setData({ role: event.currentTarget.dataset.role, errorMessage: '' });
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ [field]: event.detail.value, errorMessage: '' });
  },

  async submitRegister() {
    if (this.data.loading) return;
    const username = this.data.username.trim();
    const displayName = this.data.displayName.trim();
    const password = this.data.password;
    const confirmPassword = this.data.confirmPassword;
    const registerCode = this.data.registerCode;

    if (!/^[A-Za-z0-9_]{3,30}$/.test(username)) {
      this.setData({ errorMessage: '用户名只能包含字母、数字、下划线，长度 3–30 位' });
      return;
    }
    if (password.length < 6) {
      this.setData({ errorMessage: '密码长度至少 6 位' });
      return;
    }
    if (password !== confirmPassword) {
      this.setData({ errorMessage: '两次输入的密码不一致' });
      return;
    }
    if (!registerCode) {
      this.setData({ errorMessage: '请输入内部注册码' });
      return;
    }

    this.setData({ loading: true, errorMessage: '' });
    try {
      const result = await api.register({
        username,
        displayName,
        password,
        registerCode,
        role: this.data.role,
      });
      storage.set(storage.KEYS.REMEMBER_USERNAME, username);
      wx.showModal({
        title: '注册成功',
        content: result.message || '账号创建成功，请返回登录。',
        showCancel: false,
        success: () => wx.navigateBack(),
      });
    } catch (error) {
      this.setData({ errorMessage: error.message || '注册失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  goBack() {
    wx.navigateBack();
  },
}));
