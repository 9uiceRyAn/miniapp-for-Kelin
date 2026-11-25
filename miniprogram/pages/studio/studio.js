const workspace = require('../../utils/workspace');
const withInputHints = require('../../utils/input-hints');
const l = require('../../utils/learning');

function emptyForm() {
  return { name: '', description: '', content: '', toolPermission: 'read_only', audience: 'all', enabled: true };
}

Page(withInputHints({
  data: {
    mainTab: 'profile',
    section: 'agents-manage',
    drawerOpen: false,
    teacher: true,
    items: [],
    onlyMine: false,
    loading: false,
    sheetOpen: false,
    editingId: '',
    form: emptyForm(),
    formError: '',
    saving: false,
  },
  onResize() {
    this.setData({ navigationStyle: workspace.navigationStyle(wx) });
  },
  async onLoad(options = {}) {
    this.setData({ navigationStyle: workspace.navigationStyle(wx) });
    if (!l.guard()) return;
    await this.load();
    if (options.id) {
      await this.openEdit({ currentTarget: { dataset: { id: options.id } } });
    }
  },
  ...workspace.drawer,
  ...workspace.profileNav,
  back() {
    wx.navigateBack();
  },
  switchScope(e) {
    const onlyMine = e.currentTarget.dataset.mine === '1';
    this.setData({ onlyMine });
    this.load();
  },
  async load() {
    this.setData({ loading: true });
    try {
      const res = await l.request('/api/ai/agents?' + l.query({
        scope: 'manage',
        onlyMine: this.data.onlyMine ? 'true' : '',
        pageSize: 50,
      }));
      this.setData({ items: res.items || [] });
    } catch (e) {
      l.error(e);
    } finally {
      this.setData({ loading: false });
    }
  },
  openCreate() {
    this.setData({ sheetOpen: true, editingId: '', form: emptyForm(), formError: '' });
  },
  async openEdit(e) {
    const id = e.currentTarget.dataset.id;
    try {
      const agent = await l.request('/api/ai/agents/' + id);
      this.setData({
        sheetOpen: true,
        editingId: id,
        formError: '',
        form: {
          name: agent.name || '',
          description: agent.description || '',
          content: agent.skill?.content || '',
          toolPermission: agent.tool_permission === 'read_write' ? 'read_write' : 'read_only',
          audience: agent.audience === 'teacher_only' ? 'teacher_only' : 'all',
          enabled: agent.enabled !== 0 && agent.enabled !== false,
        },
      });
    } catch (err) {
      l.error(err);
    }
  },
  closeSheet() {
    if (!this.data.saving) this.setData({ sheetOpen: false, formError: '' });
  },
  formInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
  },
  formSelect(e) {
    const { field, value } = e.currentTarget.dataset;
    this.setData({ [`form.${field}`]: value });
  },
  async save() {
    const { form, editingId, saving } = this.data;
    if (saving) return;
    if (!String(form.name || '').trim()) return this.setData({ formError: '请输入名称' });
    if (!String(form.content || '').trim()) return this.setData({ formError: '请输入 Prompt' });
    this.setData({ saving: true, formError: '' });
    try {
      if (editingId) {
        await l.request('/api/ai/agents/' + editingId, 'PUT', form);
      } else {
        await l.request('/api/ai/agents', 'POST', form);
      }
      this.setData({ sheetOpen: false });
      wx.showToast({ title: '已保存' });
      await this.load();
    } catch (err) {
      this.setData({ formError: err.message || '保存失败' });
    } finally {
      this.setData({ saving: false });
    }
  },
  openMenu(e) {
    const item = this.data.items[e.currentTarget.dataset.index];
    if (!item) return;
    wx.showActionSheet({
      itemList: [
        item.enabled ? '停用助手' : '启用助手',
        item.pinned ? '取消置顶' : '置顶助手',
        '删除助手',
      ],
      success: async ({ tapIndex }) => {
        try {
          if (tapIndex === 0) {
            await l.request('/api/ai/agents/' + item.id + '/meta', 'PATCH', { enabled: !item.enabled });
            await this.load();
          } else if (tapIndex === 1) {
            await l.request('/api/ai/agents/' + item.id + '/meta', 'PATCH', { pinned: !item.pinned });
            await this.load();
          } else if (tapIndex === 2) {
            wx.showModal({
              title: '确认删除',
              content: `确定删除「${item.name}」？`,
              confirmColor: '#a12540',
              success: async res => {
                if (!res.confirm) return;
                try {
                  await l.request('/api/ai/agents/' + item.id, 'DELETE', {});
                  wx.showToast({ title: '已删除' });
                  await this.load();
                } catch (err) { l.error(err); }
              },
            });
          }
        } catch (err) {
          l.error(err);
        }
      },
    });
  },
}));
