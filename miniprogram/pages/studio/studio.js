const l = require('../../utils/learning');
Page({
  data: {
    id: '',
    name: '',
    description: '',
    content: '',
    toolInstructions: '',
    models: [],
    modelIndex: 0,
    references: [],
    status: 'draft',
    saving: false,
  },
  async onLoad(options) {
    if (!l.guard()) return;
    try {
      const id =
        options.id || (await l.request('/api/ai/agents', 'POST', {})).id;
      this.setData({ id });
      await this.load();
    } catch (e) {
      l.error(e);
    }
  },
  onShow() {
    if (this._refreshOnReturn) {
      this._refreshOnReturn = false;
      this.load();
    }
  },
  back() {
    wx.navigateBack();
  },
  input(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  model(e) {
    this.setData({ modelIndex: Number(e.detail.value) });
  },
  async load() {
    try {
      const [agent, models] = await Promise.all([
        l.request('/api/ai/agents/' + this.data.id),
        l.request('/api/ai/models'),
      ]);
      this.setData({
        name: agent.name,
        description: agent.description,
        content: agent.skill?.content || '',
        toolInstructions: agent.skill?.toolInstructions || '',
        references: agent.skill?.references || [],
        models,
        modelIndex: Math.max(
          0,
          models.findIndex((x) => x.id === agent.draft_model_id),
        ),
        status: agent.status,
      });
    } catch (e) {
      l.error(e);
    }
  },
  async save() {
    this.setData({ saving: true });
    try {
      await l.request('/api/ai/agents/' + this.data.id + '/draft', 'PUT', {
        name: this.data.name,
        description: this.data.description,
        content: this.data.content,
        toolInstructions: this.data.toolInstructions,
        references: this.data.references,
        modelId: this.data.models[this.data.modelIndex]?.id,
      });
      wx.showToast({ title: '草稿已保存' });
      return true;
    } catch (e) {
      l.error(e);
      return false;
    } finally {
      this.setData({ saving: false });
    }
  },
  async builder() {
    try {
      this._refreshOnReturn = true;
      const conv = await l.request(
        '/api/ai/agents/' + this.data.id + '/builder-sessions',
        'POST',
      );
      l.go('/pages/chat/chat?id=' + conv.id);
    } catch (e) {
      l.error(e);
    }
  },
  async trial() {
    if (!(await this.save())) return;
    try {
      const conv = await l.request(
        '/api/ai/agents/' + this.data.id + '/test-conversations',
        'POST',
      );
      l.go('/pages/chat/chat?id=' + conv.id);
    } catch (e) {
      l.error(e);
    }
  },
  async publish() {
    if (!(await this.save())) return;
    try {
      await l.request('/api/ai/agents/' + this.data.id + '/publish', 'POST');
      this.setData({ status: 'published' });
      wx.showToast({ title: '已发布' });
    } catch (e) {
      l.error(e);
    }
  },
  async unpublish() {
    try {
      await l.request('/api/ai/agents/' + this.data.id + '/unpublish', 'POST');
      this.setData({ status: 'unlisted' });
      wx.showToast({ title: '已下架' });
    } catch (e) {
      l.error(e);
    }
  },
  records() {
    l.go('/pages/learning/index?section=history&agentId=' + this.data.id);
  },
  costs() {
    l.go(
      '/pages/learning/index?section=usage&scope=teacher&agentId=' +
        this.data.id,
    );
  },
  async material() {
    try {
      const file = await l.pickFile();
      const doc = await l.upload('/api/library/upload', file);
      this.setData({
        references: this.data.references.concat({
          resourceId: doc.resourceId,
          revisionId: doc.revisionId,
          title: file.name,
        }),
      });
      l.go(
        '/pages/question/detail?id=' +
          doc.resourceId +
          '&revisionId=' +
          doc.revisionId +
          '&document=1',
      );
    } catch (e) {
      if (!String(e.errMsg || '').includes('cancel')) l.error(e);
    }
  },
  removeReference(e) {
    this.setData({
      references: this.data.references.filter(
        (x, i) => i !== Number(e.currentTarget.dataset.index),
      ),
    });
  },
});
