const workspace = require('../../utils/workspace');
const l = require('../../utils/learning');
const cache = require('../../utils/cache');

function viewStorage(raw) {
  if (!raw || !raw.disk) return null;
  const usedPercent = Number(raw.disk.usedPercent || 0);
  return {
    freeLabel: l.formatBytes(raw.disk.freeBytes),
    totalLabel: l.formatBytes(raw.disk.totalBytes),
    usedPercent,
    highUsage: usedPercent >= 85,
    questionBankLabel: raw.questionBank ? l.formatBytes(raw.questionBank.bytes) : '暂无数据',
    activeCount: Number(raw.uploads?.activeCount || 0),
    activeLabel: l.formatBytes(raw.uploads?.activeBytes || 0),
    trashCount: Number(raw.uploads?.trashCount || 0),
    trashLabel: l.formatBytes(raw.uploads?.trashBytes || 0),
  };
}

Page({
  data: {
    mainTab: 'profile',
    section: 'admin',
    drawerOpen: false,
    teacher: true,
    locked: true,
    password: '',
    models: [],
    prices: [],
    priceTarget: null,
    modelPrices: [],
    sheetMode: '',
    name: '',
    upstreamModel: '',
    baseURL: '',
    apiKey: '',
    fetchedModels: [],
    fetchedModelIndex: 0,
    fetchingModels: false,
    saving: false,
    busy: false,
    testingId: '',
    storage: null,
    storageLoading: false,
    settings: {},
    currency: 'USD',
    inputPrice: '',
    outputPrice: '',
    cachedPrice: '',
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
      const me = await l.getMe((m) => {
        if (m.user.role !== 'teacher') wx.navigateBack();
      });
      if (me.user.role !== 'teacher') return;
      if (l.getManagementToken()) {
        this.setData({ locked: false });
        await this.load({ force: true });
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
    const field = e.currentTarget.dataset.field;
    const patch = { [field]: e.detail.value };
    if (field === 'baseURL' || field === 'apiKey') {
      this.discoveryRequest = null;
      patch.fetchingModels = false;
      patch.fetchedModels = [];
      patch.fetchedModelIndex = 0;
    }
    this.setData(patch);
  },
  pickFetchedModel(e) {
    const idx = Number(e.detail.value);
    const chosen = this.data.fetchedModels[idx];
    if (chosen) this.setData({ fetchedModelIndex: idx, upstreamModel: chosen });
  },
  closeSheet() {
    if (this.data.saving) return;
    this.discoveryRequest = null;
    this.setData({ sheetMode: '', error: '', apiKey: '', fetchingModels: false });
  },
  openCreateSheet() {
    this.discoveryRequest = null;
    this.setData({
      sheetMode: 'create',
      name: '',
      upstreamModel: '',
      baseURL: '',
      apiKey: '',
      fetchedModels: [],
      fetchedModelIndex: 0,
      fetchingModels: false,
      error: '',
    });
  },
  openModelPriceSheet(model) {
    const source = model.currentPrice || model.matchedPrice || null;
    const rates = source?.rates || {};
    this.setData({
      sheetMode: 'price',
      priceTarget: model,
      modelPrices: this.formatPriceHistory(model.id),
      currency: source?.currency || 'USD',
      inputPrice: rates.input !== undefined ? String(rates.input) : '',
      outputPrice: rates.output !== undefined ? String(rates.output) : '',
      cachedPrice: rates.cachedInput !== undefined ? String(rates.cachedInput) : '',
      error: '',
    });
  },
  applyMatchedPrice() {
    const matched = this.data.priceTarget?.matchedPrice;
    if (!matched) return;
    this.setData({
      currency: matched.currency || 'USD',
      inputPrice: matched.rates?.input !== undefined ? String(matched.rates.input) : '',
      outputPrice: matched.rates?.output !== undefined ? String(matched.rates.output) : '',
      cachedPrice: matched.rates?.cachedInput !== undefined ? String(matched.rates.cachedInput) : '',
      error: '',
    });
    wx.showToast({ title: '已填入参考计费价格', icon: 'none' });
  },
  formatPriceHistory(modelId) {
    return (this.data.prices || [])
      .filter((p) => p.model_id === modelId)
      .map((p) => ({
        ...p,
        rateSummary: `${p.currency} ${p.rates?.input ?? '-'} / ${p.rates?.output ?? '-'}${p.rates?.cachedInput !== undefined ? ' (缓存 ' + p.rates.cachedInput + ')' : ''}`,
      }));
  },
  applyOverview({ models, prices, storage, settings }) {
    const targetId = this.data.priceTarget?.id;
    const nextTarget = targetId
      ? models.find((m) => m.id === targetId) || this.data.priceTarget
      : this.data.priceTarget;
    this.setData({
      models,
      prices,
      priceTarget: nextTarget,
      storage,
      settings,
    });
    if (targetId) {
      this.setData({ modelPrices: this.formatPriceHistory(targetId) });
    }
  },
  async load(options = {}) {
    const cached = !options.force ? cache.get('admin:overview', { maxAge: 30 * 1000 }) : null;
    if (cached) {
      this.applyOverview(cached.value);
      if (cached.fresh) return;
    }
    try {
      const [me, rawModels, prices, storage] = await Promise.all([
        l.request('/api/ai/me'),
        this.manage('models'),
        this.manage('prices'),
        this.manage('storage').catch(() => null),
      ]);
      cache.set('me', me, { persist: true });
      const models = (rawModels || []).map((m) => ({
        ...m,
        priceSummary: m.currentPrice
          ? `${m.currentPrice.currency} ${m.currentPrice.rates?.input ?? '-'} / ${m.currentPrice.rates?.output ?? '-'} / 百万token`
          : m.matchedPrice
            ? `未保存(匹配参考 ${m.matchedPrice.rates?.input}/${m.matchedPrice.rates?.output})`
            : '未配置价格',
      }));
      const overview = { models, prices, storage: viewStorage(storage), settings: me.settings || {} };
      cache.set('admin:overview', overview);
      this.applyOverview(overview);
    } catch (e) {
      if (!cached) {
        this.setData({ error: e.message });
        l.error(e);
      }
    }
  },
  async refreshStorage() {
    if (this.data.storageLoading) return;
    this.setData({ storageLoading: true });
    try {
      const storage = await this.manage('storage');
      const formatted = viewStorage(storage);
      this.setData({ storage: formatted });
      const cached = cache.get('admin:overview');
      if (cached) cache.set('admin:overview', { ...cached.value, storage: formatted });
    } catch (e) {
      l.error(e);
    } finally {
      this.setData({ storageLoading: false });
    }
  },
  async fetchModels() {
    if (this.data.fetchingModels || this.data.saving) return;
    const baseURL = this.data.baseURL.trim();
    if (!baseURL) {
      this.setData({ error: '请先填写 API 网址' });
      return;
    }
    const request = {};
    this.discoveryRequest = request;
    this.setData({ fetchingModels: true, error: '' });
    try {
      const apiKey = this.data.apiKey.trim();
      const res = await this.manage('models/discover', 'POST', {
        baseURL,
        ...(apiKey ? { apiKey } : {}),
      });
      if (this.discoveryRequest !== request || this.data.sheetMode !== 'create') return;
      const fetchedModels = res.models || [];
      const currentModel = this.data.upstreamModel.trim();
      const existingIndex = fetchedModels.indexOf(currentModel);
      const fetchedModelIndex = existingIndex >= 0 ? existingIndex : 0;
      const patch = {
        fetchedModels,
        fetchedModelIndex,
        ...(res.baseURL ? { baseURL: res.baseURL } : {}),
        ...(!currentModel && fetchedModels.length ? { upstreamModel: fetchedModels[0] } : {}),
      };
      this.setData(patch);
      wx.showToast({ title: '已获取 ' + fetchedModels.length + ' 个模型', icon: 'none' });
    } catch (e) {
      if (this.discoveryRequest === request && this.data.sheetMode === 'create')
        this.setData({ error: e.message });
    } finally {
      if (this.discoveryRequest === request) this.setData({ fetchingModels: false });
    }
  },
  async create() {
    this.discoveryRequest = null;
    this.setData({ fetchingModels: false, saving: true, error: '' });
    try {
      await this.manage('models', 'POST', {
        name: this.data.name.trim(),
        upstreamModel: this.data.upstreamModel.trim(),
        baseURL: this.data.baseURL.trim(),
        apiKey: this.data.apiKey.trim(),
        capabilities: { text: true, tools: true, vision: true },
      });
      this.setData({
        apiKey: '',
        name: '',
        upstreamModel: '',
        baseURL: '',
        fetchedModels: [],
        fetchedModelIndex: 0,
        sheetMode: '',
      });
      wx.showToast({ title: '模型已添加' });
      cache.invalidate('admin:');
      await this.load({ force: true });
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
      cache.invalidate('admin:');
      await this.load({ force: true });
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
      itemList: ['设为默认模型', '计费价格', '轮换密钥', model.enabled ? '停用模型' : '启用模型', '删除模型'],
      success: async ({ tapIndex }) => {
        if (tapIndex === 0) await this.setDefault(model.id);
        else if (tapIndex === 1) this.openModelPriceSheet(model);
        else if (tapIndex === 2) this.setData({ sheetMode: 'rotate', editId: model.id, editName: model.name, rotateKey: '', error: '' });
        else if (tapIndex === 3) await this.toggleEnabled(model);
        else if (tapIndex === 4) this.confirmDeleteModel(model);
      },
    });
  },
  async confirmDeleteModel(model) {
    if (!(await l.confirm(`确定删除「${model.name}」？删除后将从网关移除该连接，历史费用记录仍会保留。`, { title: '删除模型', confirmColor: '#d93025' }))) return;
    try {
      await this.manage('models/' + model.id, 'DELETE');
      wx.showToast({ title: '模型已删除' });
      cache.invalidate('admin:');
      await this.load({ force: true });
    } catch (e) {
      l.error(e);
    }
  },
  async toggleEnabled(model) {
    try {
      await this.manage('models/' + model.id, 'PATCH', { enabled: !model.enabled });
      wx.showToast({ title: model.enabled ? '已停用' : '已启用' });
      cache.invalidate('admin:');
      await this.load({ force: true });
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
      cache.invalidate('admin:');
      await this.load({ force: true });
    } catch (e) {
      l.error(e);
    }
  },
  async price() {
    const model = this.data.priceTarget;
    if (!model) return;
    this.setData({ saving: true, error: '' });
    try {
      const rates = {
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
      cache.invalidate('admin:');
      await this.load({ force: true });
    } catch (e) {
      this.setData({ error: e.message });
    } finally {
      this.setData({ saving: false });
    }
  },
});
