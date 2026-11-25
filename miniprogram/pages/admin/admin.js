const withInputHints = require('../../utils/input-hints');
const l = require('../../utils/learning');
Page(withInputHints({
  data: {
    models: [],
    prices: [],
    name: '',
    upstreamModel: '',
    baseURL: '',
    apiKey: '',
    vision: false,
    tools: true,
    saving: false,
    settings: {},
    selected: 0,
    currency: 'USD',
    inputPrice: '',
    outputPrice: '',
    cachedPrice: '',
    creditPrice: '',
    rotateKey: '',
    editId: '',
    error: '',
  },
  async onLoad() {
    if (!l.guard()) return;
    await this.load();
  },
  back() {
    wx.navigateBack();
  },
  input(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  toggle(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  pick(e) {
    this.setData({ selected: Number(e.detail.value) });
  },
  async load() {
    try {
      const me = await l.request('/api/ai/me');
      if (!me.admin) {
        wx.navigateBack();
        return;
      }
      const [models, prices] = await Promise.all([
        l.request('/api/ai/admin/models'),
        l.request('/api/ai/admin/prices'),
      ]);
      this.setData({
        models,
        priceModels: models.concat({ id: 'tavily', name: 'Tavily 搜索服务' }),
        prices,
        settings: me.settings,
      });
    } catch (e) {
      l.error(e);
    }
  },
  async create() {
    this.setData({ saving: true, error: '' });
    try {
      await l.request('/api/ai/admin/models', 'POST', {
        name: this.data.name,
        upstreamModel: this.data.upstreamModel,
        baseURL: this.data.baseURL || undefined,
        apiKey: this.data.apiKey,
        capabilities: {
          text: true,
          tools: this.data.tools,
          vision: this.data.vision,
        },
      });
      this.setData({ apiKey: '', name: '', upstreamModel: '', baseURL: '' });
      await this.load();
    } catch (e) {
      this.setData({ apiKey: '', error: e.message });
      l.error(e);
    } finally {
      this.setData({ saving: false });
    }
  },
  async test(e) {
    try {
      const result = await l.request(
        '/api/ai/admin/models/' + e.currentTarget.dataset.id + '/test',
        'POST',
        { kind: e.currentTarget.dataset.kind || 'text' },
      );
      wx.showToast({ title: result.message || '连接测试通过' });
      await this.load();
    } catch (e) {
      l.error(e);
    }
  },
  async enable(e) {
    try {
      await l.request(
        '/api/ai/admin/models/' + e.currentTarget.dataset.id,
        'PATCH',
        { enabled: !e.currentTarget.dataset.enabled },
      );
      await this.load();
    } catch (e) {
      l.error(e);
    }
  },
  editKey(e) {
    this.setData({ editId: e.currentTarget.dataset.id, rotateKey: '' });
  },
  async rotate() {
    try {
      await l.request('/api/ai/admin/models/' + this.data.editId, 'PATCH', {
        apiKey: this.data.rotateKey,
      });
      this.setData({ rotateKey: '', editId: '' });
      wx.showToast({ title: '密钥已更新' });
    } catch (e) {
      this.setData({ rotateKey: '' });
      l.error(e);
    }
  },
  async setDefault(e) {
    try {
      await l.request('/api/ai/admin/settings', 'PUT', {
        [e.currentTarget.dataset.field]: e.currentTarget.dataset.id,
      });
      await this.load();
    } catch (e) {
      l.error(e);
    }
  },
  async price() {
    try {
      const model = this.data.priceModels[this.data.selected];
      if (!model) return;
      const rates =
        model.id === 'tavily'
          ? { credit: this.data.creditPrice }
          : {
              input: this.data.inputPrice,
              output: this.data.outputPrice,
              ...(this.data.cachedPrice !== ''
                ? { cachedInput: this.data.cachedPrice }
                : {}),
            };
      await l.request('/api/ai/admin/prices', 'POST', {
        modelId: model.id,
        currency: this.data.currency.toUpperCase(),
        rates,
      });
      wx.showToast({ title: '价格版本已保存' });
      await this.load();
    } catch (e) {
      l.error(e);
    }
  },
  usage() {
    l.go('/pages/learning/index?section=usage&scope=admin');
  },
}));
