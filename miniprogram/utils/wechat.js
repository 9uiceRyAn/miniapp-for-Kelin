const api = require('./api');
const storage = require('./storage');

function request(path, data) {
  return api.request({ path: '/api/auth/wechat/' + path, method: 'POST', data, auth: false });
}

function uploadAvatar(filePath, token) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: api.API_BASE_URL + '/api/auth/avatar',
      filePath,
      name: 'file',
      header: { Authorization: 'Bearer ' + token },
      success(res) {
        let body;
        try { body = JSON.parse(res.data); } catch { return reject(new Error('头像上传响应无效')); }
        if (res.statusCode >= 200 && res.statusCode < 300 && body.success && body.data?.avatarUrl) {
          resolve(body.data.avatarUrl);
        } else {
          reject(new Error(body.message || '头像上传失败'));
        }
      },
      fail: reject,
    });
  });
}

function finish(page, data) {
  if (page._left) return;
  storage.remove(storage.KEYS.REMEMBER_TOKEN);
  storage.saveSession(data);
  page.setData({ wechatTicket: '', wechatAvatarPath: '', wechatDisplayName: '' });
  wx.reLaunch({
    url: '/pages/learning/index',
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
          wechatAvatarPath: '',
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
  wechatChooseAvatar(e) {
    const avatarUrl = e.detail?.avatarUrl || '';
    if (avatarUrl) this.setData({ wechatAvatarPath: avatarUrl, errorMessage: '' });
  },
  wechatNicknameInput(e) {
    this.setData({ wechatDisplayName: e.detail?.value ?? '', errorMessage: '' });
  },
  onWechatNicknameBlur(e) {
    if (typeof this.onInputHintBlur === 'function') this.onInputHintBlur(e);
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
      if (action === 'register' && this.data.wechatAvatarPath && data.token) {
        try {
          const avatarUrl = await uploadAvatar(this.data.wechatAvatarPath, data.token);
          data.user = { ...data.user, avatarUrl };
        } catch {}
      }
      finish(this, data);
    } catch (e) {
      this.setData({
        loading: false,
        errorMessage: e.message || (action === 'register' ? '注册失败' : '绑定失败'),
      });
    }
  },
};
