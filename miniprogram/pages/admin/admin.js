const workspace = require('../../utils/workspace');
const withInputHints = require('../../utils/input-hints');
const l = require('../../utils/learning');

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n < 1024 * 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  return (n / (1024 * 1024 * 1024 * 1024)).toFixed(2) + ' TB';
}

function viewStorage(raw) {
  if (!raw || !raw.disk) return null;
  const usedPercent = Number(raw.disk.usedPercent || 0);
  return {
    freeLabel: formatBytes(raw.disk.freeBytes),
    totalLabel: formatBytes(raw.disk.totalBytes),
    usedPercent,
    highUsage: usedPercent >= 85,
    activeCount: Number(raw.uploads?.activeCount || 0),
    activeLabel: formatBytes(raw.uploads?.activeBytes || 0),
    trashCount: Number(raw.uploads?.trashCount || 0),
    trashLabel: formatBytes(raw.uploads?.trashBytes || 0),
  };
}

Page(withInputHints({
  data: {
    mainTab: 'profile',
    section: 'admin',
    drawerOpen: false,
    teacher: true,
    locked: true,
    password: '',
    models: [],
    priceModels: [],
    prices: [],
    sheetMode: '',
    name: '',
    upstreamModel: '',
    baseURL: '',
    apiKey: '',
    saving: false,
    busy: false,
    testingId: '',
    storage: null,
    storageLoading: false,
    settings: {},
    selected: 0,
    currency: 'USD',
    inputPrice: '',
    outputPrice: '',
    cachedPrice: '',
    creditPrice: '',
    rotateKey: '',
    editId: '',
    editName: '',
    error: '',
  },
  onResize() {
    this.setData({ navigationStyle: workspace.navigationStyle(wx) });
  },
  async onLoad() {
    this.setData({ navigationStyle: workspace.navigationStyle(wx) });
    if (!l.guard()) return;
    try {
      const me = await l.request('/api/ai/me');
      if (me.user.role !== 'teacher') {
        wx.navigateBack();
        return;
      }
      if (l.getManagementToken()) {
        this.setData({ locked: false });
        await this.load();
      }
    } catch (e) {
      l.error(e);
    }
  },
  async unlock() {
    const password = this.data.password;
    if (!password) return;
    this.setData({ password: '', error: '', busy: true });
    try {
      const grant = await l.request('/api/ai/admin/unlock', 'POST', { password });
      l.setManagementToken(grant.token, grant.expiresAt);
      this.setData({ locked: false });
      await this.load();
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ busy: false });
    }
  },
  async manage(path, method = 'GET', data = {}) {
    try {
      return await l.managementRequest('/api/ai/admin/' + path, method, data);
    } catch (error) {
      if (error.statusCode === 403 && error.payload?.code === 'MANAGEMENT_LOCKED') {
        l.clearManagementToken();
        this.setData({ locked: true, sheetMode: '', apiKey: '', rotateKey: '', editId: '' });
      }
      throw error;
    }
  },
  ...workspace.drawer,
  ...workspace.profileNav,
  back() {
    wx.navigateBack();
  },
  input(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  pick(e) {
    this.setData({ selected: Number(e.detail.value) });
  },
  closeSheet() {
    if (!this.data.saving) this.setData({ sheetMode: '', error: '' });
  },
  openCreateSheet() {
    this.setData({ sheetMode: 'create', name: '', upstreamModel: '', baseURL: '', apiKey: '', error: '' });
  },
  openPriceSheet() {
    this.setData({ sheetMode: 'price', error: '' });
  },
  async load() {
    try {
      const [me, models, prices, storage] = await Promise.all([
        l.request('/api/ai/me'),
        this.manage('models'),
        this.manage('prices'),
        this.manage('storage').catch(() => null),
      ]);
      this.setData({
        models,
        priceModels: models.concat({ id: 'tavily', name: 'Tavily 搜索服务' }),
        prices,
        storage: viewStorage(storage),
        settings: me.settings || {},
      });
    } catch (e) {
      this.setData({ error: e.message });
      l.error(e);
    }
  },
  async refreshStorage() {
    if (this.data.storageLoading) return;
    this.setData({ storageLoading: true });
    try {
      const storage = await this.manage('storage');
      this.setData({ storage: viewStorage(storage) });
    } catch (e) {
      l.error(e);
    } finally {
      this.setData({ storageLoading: false });
    }
  },
  async create() {
    this.setData({ saving: true, error: '' });
    try {
      await this.manage('models', 'POST', {
        name: this.data.name,
        upstreamModel: this.data.upstreamModel,
        baseURL: this.data.baseURL || undefined,
        apiKey: this.data.apiKey,
        capabilities: { text: true, tools: true, vision: true },
      });
      this.setData({ apiKey: '', name: '', upstreamModel: '', baseURL: '', sheetMode: '' });
      wx.showToast({ title: '模型已添加' });
      await this.load();
    } catch (e) {
      this.setData({ apiKey: '', error: e.message });
    } finally {
      this.setData({ saving: false });
    }
  },
  async test(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ testingId: id, error: '' });
    try {
      const result = await this.manage('models/' + id + '/test', 'POST', { kind: 'all' });
      wx.showToast({ title: result.message || '连接测试通过', icon: 'none' });
      await this.load();
    } catch (err) {
      l.error(err);
    } finally {
      this.setData({ testingId: '' });
    }
  },
  openModelMenu(e) {
    const model = this.data.models[e.currentTarget.dataset.index];
    if (!model) return;
    wx.showActionSheet({
      itemList: ['设为默认模型', '轮换密钥', model.enabled ? '停用模型' : '启用模型'],
      success: async ({ tapIndex }) => {
        if (tapIndex === 0) await this.setDefault(model.id);
        else if (tapIndex === 1) this.setData({ sheetMode: 'rotate', editId: model.id, editName: model.name, rotateKey: '', error: '' });
        else if (tapIndex === 2) await this.toggleEnabled(model);
      },
    });
  },
  async toggleEnabled(model) {
    try {
      await this.manage('models/' + model.id, 'PATCH', { enabled: !model.enabled });
      wx.showToast({ title: model.enabled ? '已停用' : '已启用' });
      await this.load();
    } catch (e) {
      l.error(e);
    }
  },
  async rotate() {
    this.setData({ saving: true, error: '' });
    try {
      await this.manage('models/' + this.data.editId, 'PATCH', { apiKey: this.data.rotateKey });
      this.setData({ rotateKey: '', editId: '', sheetMode: '' });
      wx.showToast({ title: '密钥已更新' });
    } catch (e) {
      this.setData({ rotateKey: '', error: e.message });
    } finally {
      this.setData({ saving: false });
    }
  },
  async setDefault(id) {
    try {
      await this.manage('settings', 'PUT', { defaultModelId: id });
      wx.showToast({ title: '已设为默认模型' });
      await this.load();
    } catch (e) {
      l.error(e);
    }
  },
  async price() {
    const model = this.data.priceModels[this.data.selected];
    if (!model) return;
    this.setData({ saving: true, error: '' });
    try {
      const rates =
        model.id === 'tavily'
          ? { credit: this.data.creditPrice }
          : {
              input: this.data.inputPrice,
              output: this.data.outputPrice,
              ...(this.data.cachedPrice !== '' ? { cachedInput: this.data.cachedPrice } : {}),
            };
      await this.manage('prices', 'POST', {
        modelId: model.id,
        currency: this.data.currency.toUpperCase(),
        rates,
      });
      wx.showToast({ title: '价格版本已保存' });
      await this.load();
    } catch (e) {
      this.setData({ error: e.message });
    } finally {
      this.setData({ saving: false });
    }
  },
  usage() {
    l.go('/pages/learning/index?section=usage&scope=admin');
  },
}));
