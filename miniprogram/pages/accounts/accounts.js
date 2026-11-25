const workspace = require('../../utils/workspace');
const learning = require('../../utils/learning');
const withInputHints = require('../../utils/input-hints');
const blankPasswords = { currentPassword: '', newPassword: '', confirmPassword: '' };

function api(path, method = 'GET', data = {}) {
  return learning.managementRequest('/api/teacher-admin' + path, method, data);
}

function confirm(content) {
  return new Promise(resolve => wx.showModal({
    title: '确认操作',
    content,
    confirmColor: '#a12540',
    success: result => resolve(result.confirm),
    fail: () => resolve(false),
  }));
}

Page(withInputHints({
  data: {
    mainTab: 'profile',
    section: 'accounts',
    drawerOpen: false,
    teacher: false,
    authorized: false,
    ...blankPasswords,
    password: '',
    users: [],
    codes: [],
    q: '',
    role: '',
    status: '',
    page: 1,
    total: 0,
    sheetMode: '',
    editingUser: null,
    editedName: '',
    editedPassword: '',
    code_teacher: '',
    code_student: '',
    selfId: null,
    busy: false,
    error: '',
  },
  onResize() {
    this.setData({ navigationStyle: workspace.navigationStyle(wx) });
  },
  onLoad() {
    this.setData({ navigationStyle: workspace.navigationStyle(wx) });
    if (!learning.guard()) return;
    this.init();
  },
  ...workspace.drawer,
  ...workspace.profileNav,
  back() {
    wx.navigateBack();
  },
  async init() {
    try {
      const { user } = await learning.request('/api/ai/me');
      if (user.role !== 'teacher') {
        this.setData({ error: '仅教师账号可使用账号管理' });
        return;
      }
      this.setData({ selfId: user.id, teacher: true });
      if (learning.getManagementToken()) {
        this.setData({ authorized: true });
        await this.loadAll();
      }
    } catch (error) {
      this.setData({ error: error.message });
    }
  },
  async unlock() {
    const password = this.data.password;
    if (!password) return;
    this.setData({ password: '', error: '' });
    await this.run(async () => {
      const grant = await learning.request('/api/teacher-admin/unlock', 'POST', { password });
      learning.setManagementToken(grant.token, grant.expiresAt);
      this.setData({ authorized: true });
      await this.loadAll();
    });
  },
  async loadAll() {
    await Promise.all([this.loadCodes(), this.loadUsers()]);
  },
  async run(action) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await action();
    } catch (error) {
      if (error.statusCode === 401) learning.error(error);
      if (error.statusCode === 403 && error.payload?.code === 'MANAGEMENT_LOCKED') {
        learning.clearManagementToken();
        this.setData({ authorized: false, sheetMode: '', codes: [], users: [], ...blankPasswords });
      }
      this.setData({ error: error.message });
    } finally {
      this.setData({ busy: false });
    }
  },
  async loadCodes() {
    this.setData(await api('/codes'));
  },
  async loadUsers() {
    const { q, role, status, page } = this.data;
    const result = await api('/users?page=' + page + '&q=' + encodeURIComponent(q) + '&role=' + role + '&status=' + status);
    this.setData({ ...result });
  },
  input(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },
  role(event) {
    this.setData({ role: ['', 'teacher', 'student'][event.detail.value] });
    this.search();
  },
  status(event) {
    this.setData({ status: ['', '1', '0'][event.detail.value] });
    this.search();
  },
  search() {
    if (!this.data.busy) {
      this.setData({ page: 1 });
      return this.run(() => this.loadUsers());
    }
  },
  prev() {
    this.setData({ page: this.data.page - 1 });
    this.run(() => this.loadUsers());
  },
  next() {
    this.setData({ page: this.data.page + 1 });
    this.run(() => this.loadUsers());
  },
  openUserSheet(event) {
    const user = this.data.users[event.currentTarget.dataset.index];
    if (!user) return;
    this.setData({
      sheetMode: 'user',
      editingUser: user,
      editedName: user.display_name || user.username,
      editedPassword: '',
      error: '',
    });
  },
  openCodes() {
    this.setData({ sheetMode: 'codes', error: '' });
  },
  openManagementPassword() {
    this.setData({ sheetMode: 'password', error: '', ...blankPasswords });
  },
  changeManagementPassword() {
    return this.run(async () => {
      const { currentPassword, newPassword, confirmPassword } = this.data;
      if (newPassword !== confirmPassword) throw new Error('两次输入的新密码不一致');
      await api('/password', 'PUT', { currentPassword, newPassword });
      learning.clearManagementToken();
      this.setData({ authorized: false, sheetMode: '', users: [], codes: [], ...blankPasswords });
      wx.showToast({ title: '管理员密码已更新' });
    });
  },
  closeSheet() {
    if (!this.data.busy) this.setData({ sheetMode: '', editingUser: null, error: '', ...blankPasswords });
  },
  copy(event) {
    wx.setClipboardData({ data: this.data.codes[event.currentTarget.dataset.index].code });
  },
  saveCode(event) {
    const item = this.data.codes[event.currentTarget.dataset.index];
    const value = this.data['code_' + item.role];
    this.run(async () => {
      if (!await confirm('保存后原' + (item.role === 'teacher' ? '教师码' : '学生码') + '立即失效，确认修改？')) return;
      await api('/codes/' + item.role, 'PUT', { code: value, version: item.version });
      this.setData({ ['code_' + item.role]: '' });
      wx.showToast({ title: '注册码已更新' });
      await this.loadCodes();
    });
  },
  saveName() {
    const user = this.data.editingUser;
    if (!user) return;
    this.run(async () => {
      await api('/users/' + user.id, 'PATCH', { displayName: this.data.editedName.trim() });
      wx.showToast({ title: '显示名已保存' });
      await this.loadUsers();
      const updated = this.data.users.find(u => u.id === user.id);
      this.setData({ editingUser: updated || null, ...(updated ? {} : { sheetMode: '' }) });
    });
  },
  savePassword() {
    const user = this.data.editingUser;
    if (!user) return;
    this.run(async () => {
      if (!await confirm('重置 ' + user.username + ' 的密码将退出该账号全部登录会话，确认继续？')) return;
      await api('/users/' + user.id, 'PATCH', { password: this.data.editedPassword });
      this.setData({ editedPassword: '' });
      wx.showToast({ title: '密码已重置' });
    });
  },
  toggleStatus() {
    const user = this.data.editingUser;
    if (!user) return;
    this.run(async () => {
      if (!await confirm('确认' + (user.status === 1 ? '停用' : '启用') + ' ' + user.username + '？')) return;
      await api('/users/' + user.id, 'PATCH', { status: user.status === 1 ? 0 : 1 });
      wx.showToast({ title: user.status === 1 ? '账号已停用' : '账号已启用' });
      await this.loadUsers();
      const updated = this.data.users.find(u => u.id === user.id);
      this.setData({ editingUser: updated || null, ...(updated ? {} : { sheetMode: '' }) });
    });
  },
}));
