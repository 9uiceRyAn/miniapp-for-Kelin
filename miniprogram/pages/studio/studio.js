const workspace = require('../../utils/workspace');
const l = require('../../utils/learning');
const cache = require('../../utils/cache');

function emptyForm() {
  return { name: '', description: '', content: '', toolPermission: 'read_only', audience: 'all', enabled: true };
}

Page({
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
  async load(options = {}) {
    const cacheKey = 'studio:agents:' + (this.data.onlyMine ? 'mine' : 'all');
    const cached = !options.force ? cache.get(cacheKey, { maxAge: 30 * 1000 }) : null;
    if (cached) {
      this.setData({ items: cached.value, loading: false });
      if (cached.fresh) return;
    } else {
      this.setData({ loading: true });
    }
    try {
      const res = await l.request('/api/ai/agents?' + l.query({
        scope: 'manage',
        onlyMine: this.data.onlyMine ? 'true' : '',
        pageSize: 50,
      }));
      const items = res.items || [];
      cache.set(cacheKey, items);
      this.setData({ items });
    } catch (e) {
      if (!cached) l.error(e);
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
    if (!form.name.trim()) return this.setData({ formError: '请输入名称' });
    if (!form.content.trim()) return this.setData({ formError: '请输入 Prompt' });
    this.setData({ saving: true, formError: '' });
    try {
      if (editingId) {
        await l.request('/api/ai/agents/' + editingId, 'PUT', form);
      } else {
        await l.request('/api/ai/agents', 'POST', form);
      }
      this.setData({ sheetOpen: false });
      wx.showToast({ title: '已保存' });
      cache.invalidate('studio:agents:');
      cache.invalidate('agents:');
      await this.load({ force: true });
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
            cache.invalidate('studio:agents:');
            cache.invalidate('agents:');
            await this.load({ force: true });
          } else if (tapIndex === 1) {
            await l.request('/api/ai/agents/' + item.id + '/meta', 'PATCH', { pinned: !item.pinned });
            cache.invalidate('studio:agents:');
            cache.invalidate('agents:');
            await this.load({ force: true });
          } else if (tapIndex === 2) {
            if (!(await l.confirm(`确定删除「${item.name}」？`, { title: '确认删除', confirmColor: '#a12540' }))) return;
            await l.request('/api/ai/agents/' + item.id, 'DELETE', {});
            wx.showToast({ title: '已删除' });
            cache.invalidate('studio:agents:');
            cache.invalidate('agents:');
            await this.load({ force: true });
          }
        } catch (err) {
          l.error(err);
        }
      },
    });
  },
});
