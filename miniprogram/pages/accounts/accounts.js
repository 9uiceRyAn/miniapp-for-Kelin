const learning = require('../../utils/learning');
function api(path, method = 'GET', data = {}) {
  return learning.request('/api/teacher-admin' + path, method, data);
}
function confirm(content) {
  return new Promise(resolve => wx.showModal({ title: '确认操作', content, success: result => resolve(result.confirm), fail: () => resolve(false) }));
}
const withInputHints = require('../../utils/input-hints');
Page(withInputHints({
  data: { authorized: false, users: [], codes: [], q: '', role: '', status: '', page: 1, total: 0,
    editingId: null, editedName: '', editedPassword: '', selfId: null, busy: false, error: '' },
  onLoad() {
    if (!learning.guard()) return;
    return this.run(async () => {
      const { user } = await learning.request('/api/ai/me');
      if (user.role !== 'teacher') {
        this.setData({ error: '仅教师账号可使用教师管理' });
        return;
      }
      this.setData({ authorized: true, selfId: user.id });
      await Promise.all([this.loadCodes(), this.loadUsers()]);
    });
  },
  async run(action) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try { await action(); } catch (error) {
      if (error.statusCode === 401) learning.error(error);
      if (error.statusCode === 403) this.setData({ authorized: false, codes: [], users: [] });
      this.setData({ error: error.message });
    }
    finally { this.setData({ busy: false }); }
  },
  async loadCodes() { this.setData(await api('/codes')); },
  async loadUsers() {
    const { q, role, status, page } = this.data;
    const result = await api('/users?page=' + page + '&q=' + encodeURIComponent(q) + '&role=' + role + '&status=' + status);
    this.setData({ ...result, editingId: null, editedName: '', editedPassword: '' });
  },
  toggleUser(event) {
    if (this.data.busy) return;
    const user = this.data.users[event.currentTarget.dataset.index];
    const opening = this.data.editingId !== user.id;
    this.setData({ editingId: opening ? user.id : null, editedName: opening ? (user.display_name || user.username) : '',
      editedPassword: '', error: '' });
  },
  input(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); },
  role(event) { this.setData({ role: ['', 'teacher', 'student'][event.detail.value] }); this.search(); },
  status(event) { this.setData({ status: ['', '1', '0'][event.detail.value] }); this.search(); },
  search() { if (!this.data.busy) { this.setData({ page: 1 }); return this.run(() => this.loadUsers()); } },
  prev() { this.setData({ page: this.data.page - 1 }); this.run(() => this.loadUsers()); },
  next() { this.setData({ page: this.data.page + 1 }); this.run(() => this.loadUsers()); },
  copy(event) { wx.setClipboardData({ data: this.data.codes[event.currentTarget.dataset.index].code }); },
  saveCode(event) {
    const item = this.data.codes[event.currentTarget.dataset.index];
    const value = this.data['code_' + item.role];
    this.run(async () => {
      if (!await confirm('保存后原' + (item.role === 'teacher' ? '教师码' : '学生码') + '立即失效，确认修改？')) return;
      await api('/codes/' + item.role, 'PUT', { code: value, version: item.version });
      this.setData({ ['code_' + item.role]: '' });
      await this.loadCodes();
    });
  },
  update(event) {
    const user = this.data.users[event.currentTarget.dataset.index];
    const action = event.currentTarget.dataset.action;
    this.run(async () => {
      let body;
      if (action === 'name') body = { displayName: this.data.editedName.trim() };
      if (action === 'status') {
        if (!await confirm('确认' + (user.status === 1 ? '停用' : '启用') + user.username + '？')) return;
        body = { status: user.status === 1 ? 0 : 1 };
      }
      if (action === 'password') {
        if (!await confirm('重置 ' + user.username + ' 的密码将退出该账号全部登录会话，确认继续？')) return;
        body = { password: this.data.editedPassword };
      }
      await api('/users/' + user.id, 'PATCH', body);
      this.setData({ editedPassword: '' });
      await this.loadUsers();
    });
  }
}));
