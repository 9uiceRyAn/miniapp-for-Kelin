const api = require('./api');
const storage = require('./storage');

function request(path, data) {
  return api.request({ path: '/api/auth/wechat/' + path, method: 'POST', data, auth: false });
}

function finish(page, data) {
  if (page._left) return;
  storage.remove(storage.KEYS.REMEMBER_TOKEN);
  storage.saveSession(data);
  page.setData({ wechatTicket: '', wechatDisplayName: '' });
  wx.reLaunch({
    url: '/pages/learning/index?section=agents',
    fail: () => page.setData({ loading: false }),
  });
}

module.exports = {
  async wechatLogin() {
    if (!this.data.wechatEnabled || this.data.loading || this.data.autoLoggingIn) return;
    this.setData({ loading: true, errorMessage: '' });
    try {
      const login = await new Promise((resolve, reject) => wx.login({ success: resolve, fail: reject }));
      const data = await request('mini', { code: login.code });
      if (this._left) return;
      if (data.needsAccount) {
        this.setData({
          wechatTicket: data.ticket,
          wechatAction: 'register',
          wechatRole: 'student',
          wechatDisplayName: '',
          wechatRegisterCode: '',
          loading: false,
        });
      } else {
        finish(this, data);
      }
    } catch (e) {
      this.setData({ loading: false, errorMessage: e.message || '微信登录失败' });
    }
  },
  wechatField(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value, errorMessage: '' });
  },
  wechatMode(e) {
    this.setData({ wechatAction: e.currentTarget.dataset.mode, errorMessage: '' });
  },
  wechatRole(e) {
    const role = e.currentTarget.dataset.role;
    if (role !== 'student' && role !== 'teacher') return;
    this.setData({ wechatRole: role, errorMessage: '' });
  },
  wechatNicknameInput(e) {
    this.setData({ wechatDisplayName: e.detail?.value ?? '', errorMessage: '' });
  },
  onWechatNicknameBlur(e) {
    if (e.detail && e.detail.value !== undefined) {
      this.setData({ wechatDisplayName: e.detail.value });
    }
  },
  async wechatComplete(event) {
    if (this.data.loading || this.data.autoLoggingIn) return;
    this.setData({ loading: true, errorMessage: '' });
    const { wechatTicket: ticket, wechatAction: action } = this.data;
    try {
      const displayName = (event?.detail?.value?.displayName || this.data.wechatDisplayName || '').trim();
      const fields = action === 'bind'
        ? { username: this.data.username, password: this.data.password }
        : {
            role: this.data.wechatRole,
            registerCode: this.data.wechatRegisterCode,
            displayName,
          };
      const data = await request('complete', { ticket, action, ...fields });
      finish(this, data);
    } catch (e) {
      this.setData({
        loading: false,
        errorMessage: e.message || (action === 'register' ? '注册失败' : '绑定失败'),
      });
    }
  },
};
