const withInputHints = require('../../utils/input-hints');
const l = require('../../utils/learning');
const workspace = require('../../utils/workspace');
const usageView = require('../../utils/usage');
Page(withInputHints({
  data: {
    section: 'bank',
    motionRevision: 0,
    mainTab: 'bank',
    drawerOpen: false,
    filtersOpen: false,
    subjectLabel: '全部学科',
    sectionTitle: '题库',
    questionGroups: [],
    recentConversations: [],
    conversationGroups: [],
    recentPage: 1,
    recentHasMore: false,
    recentLoading: false,
    landingText: '',
    agentIndex: 0,
    startingChat: false,
    user: {},
    profileInitial: 'C',
    admin: false,
    teacher: false,
    items: [],
    total: 0,
    page: 1,
    loading: false,
    q: '',
    subject: '',
    collection: '',
    skill: '',
    tag: '',
    usableOnly: false,
    reviewRequired: '',
    subjects: [{ id: '', label: '全部学科' }],
    collections: [{ id: '', label: '全部数据集' }],
    skills: [{ id: '', label: '全部技能' }],
    tags: [{ code: '', label: '全部标签' }],
    collectionIndex: 0,
    skillIndex: 0,
    tagIndex: 0,
    usageOverview: { currencies: [], cnyAmount: null, cnyExcludedCalls: 0, exchangeNote: '', totalCalls: 0, pendingCalls: 0, unpricedCalls: 0 },
    usagePeriod: '全部日期',
    usageFiltersOpen: false,
    usageFilterError: '',
    expandedUsageId: '',
    scope: 'self',
    agentId: '',
    from: '',
    to: '',
    userId: '',
    publicText: '',
    publicTitle: '',
    uploading: false,
    existingFiles: [],
    existingLoading: false,
    existingLoaded: false,
    indexingFile: '',
    submittingText: false,
    category: 'A',
    chooseExisting: false,
  },
  openTeacherManagement() {
    if (this.data.teacher) l.go('/pages/accounts/accounts');
  },
  onResize() { this.setData({ navigationStyle: workspace.navigationStyle(wx) }); },
  onLoad(options) {
    this.setData({ navigationStyle: workspace.navigationStyle(wx) });
    if (!l.guard()) return;
    this.setData({
      section: options.section || 'bank',
      agentId: options.agentId || '',
      scope: options.scope || 'self',
    });
    this.initialize();
  },
  onShow() {
    if (this._ready) this.load(true);
  },
  async initialize() {
    try {
      const me = await l.request('/api/ai/me');
      this.setData({
        user: me.user,
        profileInitial: Array.from(me.user.display_name || me.user.name || me.user.username || 'C')[0].toUpperCase(),
        admin: me.admin,
        teacher: me.user.role === 'teacher',
      });
      this._ready = true;
      if (this.data.section === 'library' && this.data.teacher) {
        await this.openLibraryManager();
        return;
      }
      await this.facets();
      const section = this.data.section === 'chat' ? 'agents' : this.data.section;
      this.setData({ section, mainTab: this.tabFor(section), sectionTitle: this.titleFor(section) });
      if (section === 'bank' && !this.data.subject && this.data.subjects.length > 1) {
        await this.selectSubject({ currentTarget: { dataset: { index: 1 } } });
      } else {
      await this.load(true);
      }
      await this.loadRecent();
    } catch (e) {
      l.error(e);
    }
  },
  home() { if (this.data.admin) l.go('/pages/home/home'); },
  openConnections() { l.go('/pages/admin/admin?mode=connections'); },
  openAdmin() {
    l.go('/pages/admin/admin');
  },
  tabFor(section) {
    return ['agents', 'teacher', 'history'].includes(section) ? 'chat' : ['bank', 'library'].includes(section) ? section : 'profile';
  },
  titleFor(section) {
    return { bank: '题库', agents: '学习助手', history: '会话历史', profile: '个人中心', library: '公共教学资料', teacher: '我的教学助手', usage: '用量与费用' }[section] || '学习工作台';
  },
  ...workspace.drawer,
  toggleFilters() { this.setData({ filtersOpen: !this.data.filtersOpen }); },
  ...workspace.recentMethods(l),
  async selectMain(e) {
    const id = e.currentTarget.dataset.id;
    const section = id === 'chat' ? 'agents' : id;
    await this.selectSection({ currentTarget: { dataset: { id: section } } });
  },
  async selectSection(e) {
    if (e.currentTarget.dataset.id === 'library' && this.data.teacher) return this.openLibraryManager();
    const section = e.currentTarget.dataset.id;
    // Search belongs to its content area; preserve bank filters across tabs.
    this._queries = this._queries || {};
    this._queries[this.data.section] = this.data.q;
    this._facetRequestId = (this._facetRequestId || 0) + 1;
    this.setData({
      section,
      inputHintFocus: '',
      motionRevision: this.data.motionRevision + 1,
      mainTab: this.tabFor(section),
      sectionTitle: this.titleFor(section),
      drawerOpen: false,
      items: [],
      questionGroups: [],
      agentId: '',
      scope: 'self',
      q: this._queries[section] || '',
    });
    if (section === 'bank' && !this._facets) await this.facets();
    if (section === 'bank' && this._tagsPending && !(await this.refreshTags())) return;
    await this.load(true);
    if (this.data.mainTab === 'chat') await this.loadRecent();
  },
  async openLibraryManager() {
    if (this.data.startingChat) return;
    this._requestId = (this._requestId || 0) + 1;
    this.setData({ startingChat: true, section: 'library', mainTab: 'library', sectionTitle: '教学资料管家', libraryError: '', drawerOpen: false, items: [], loading: false });
    try {
      const conversation = await l.request('/api/ai/library-manager/conversation', 'POST', {});
      if (this.data.section === 'library') l.go('/pages/chat/chat?id=' + encodeURIComponent(conversation.id) + '&mode=library');
      this.closeDrawer();
    } catch (e) { this.setData({ libraryError: e.message || '资料管家暂时无法打开' }); }
    finally { this.setData({ startingChat: false }); }
  },
  chooseAgent(e) { this.setData({ agentIndex: Number(e.detail.value) }); },
  async startChat() {
    const agent = this.data.items[this.data.agentIndex];
    if (!agent || this.data.startingChat) return;
    this.setData({ startingChat: true });
    try {
      const conv = await l.request('/api/ai/conversations', 'POST', { agentId: agent.id });
      l.go('/pages/chat/chat?id=' + encodeURIComponent(conv.id) + '&initialText=' + encodeURIComponent(this.data.landingText));
      this.setData({ landingText: '' });
    } catch (e) { l.error(e); }
    finally { this.setData({ startingChat: false }); }
  },
  input(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  async facets() {
    const found = await l.request('/api/question-bank/facets');
    this._facets = found;
    this.setData({
      subjects: [
        { id: '', label: '全部学科' },
        ...Array.from(
          new Map(
            found.map((x) => [
              x.subject,
              { id: x.subject, label: x.subjectLabel || x.subject },
            ]),
          ).values(),
        ),
      ],
    });
    this.updateFacetOptions();
  },
  updateFacetOptions() {
    const rows = (this._facets || []).filter(
      (x) => !this.data.subject || x.subject === this.data.subject,
    );
    this.setData({
      collections: [
        { id: '', label: '全部数据集' },
        ...Array.from(
          new Map(
            rows.map((x) => [
              x.collection,
              { id: x.collection, label: x.collectionLabel || x.collection },
            ]),
          ).values(),
        ),
      ],
      skills: [
        { id: '', label: '全部技能' },
        ...Array.from(
          new Map(
            rows
              .filter(
                (x) =>
                  !this.data.collection ||
                  x.collection === this.data.collection,
              )
              .map((x) => [
                x.skill,
                { id: x.skill, label: x.skillLabel || x.skill },
              ]),
          ).values(),
        ),
      ],
    });
  },
  async filter(e) {
    const field = e.currentTarget.dataset.field,
      index = Number(e.detail.value),
      array = {
        subject: 'subjects',
        collection: 'collections',
        skill: 'skills',
        tag: 'tags',
      }[field],
      entry = this.data[array][index];
    const values = {
      [field]: entry.id === undefined ? entry.code : entry.id,
      [field + 'Index']: index,
    };
    if (field === 'subject')
      Object.assign(values, {
        collection: '',
        skill: '',
        tag: '',
        collectionIndex: 0,
        skillIndex: 0,
        tagIndex: 0,
      });
    if (field === 'collection')
      Object.assign(values, { skill: '', tag: '', skillIndex: 0, tagIndex: 0 });
    this.setData(values);
    this.updateFacetOptions();
    if (field === 'collection' || field === 'subject') {
      if (!(await this.refreshTags())) return;
    }
    await this.load(true);
  },
  async refreshTags() {
    const requestId = (this._facetRequestId || 0) + 1;
    this._facetRequestId = requestId;
    this._tagsPending = true;
    this._requestId = (this._requestId || 0) + 1;
    const collections = this.data.collections.filter(x => x.id && (!this.data.collection || x.id === this.data.collection));
    this.setData({ tags: [{ key: 'all', code: '', label: '全部', collection: '' }], tagIndex: 0, loading: true });
    try {
      const groups = (this.data.subject || this.data.collection) ? await Promise.all(collections.map(async collection => {
        const tags = await l.request('/api/question-bank/taxonomy?' + l.query({ collection: collection.id }));
        return tags.map(tag => ({ ...tag, key: collection.id + ':' + tag.code, collection: collection.id, displayLabel: collections.length > 1 ? tag.label + ' · ' + collection.label : tag.label }));
      })) : [];
      if (requestId !== this._facetRequestId) return false;
      this._tagsPending = false;
      this.setData({ tags: [{ key: 'all', code: '', label: '全部', collection: '' }, ...groups.flat()], loading: false });
      return true;
    } catch (e) {
      if (requestId === this._facetRequestId) { this.setData({ loading: false }); l.error(e); }
      return false;
    }
  },
  async selectSubject(e) {
    const index = Number(e.currentTarget.dataset.index), subject = this.data.subjects[index];
    if (!subject) return;
    this.setData({ subject: subject.id, subjectLabel: subject.label, collection: '', skill: '', tag: '', q: '', collectionIndex: 0, skillIndex: 0, tagIndex: 0, reviewRequired: '', drawerOpen: false, items: [], questionGroups: [], page: 1 });
    this.updateFacetOptions();
    if (await this.refreshTags()) await this.load(true);
  },
  async selectTag(e) {
    const index = Number(e.currentTarget.dataset.index), tag = this.data.tags[index];
    if (!tag) return;
    this.setData({ tag: tag.code, tagIndex: index, collection: tag.collection || '', collectionIndex: Math.max(0, this.data.collections.findIndex(c => c.id === tag.collection)), skill: '', skillIndex: 0 });
    this.updateFacetOptions();
    await this.load(true);
  },
  review(e) {
    this.setData({ usableOnly: false, reviewRequired: e.detail.value ? 'true' : '' });
    this.load(true);
  },
  usable(e) {
    this.setData({ usableOnly: e.detail.value, reviewRequired: '' });
    this.load(true);
  },
  async clear() {
    this.setData({
      q: '',
      collection: '',
      skill: '',
      tag: '',
      usableOnly: false,
      reviewRequired: '',
      collectionIndex: 0,
      skillIndex: 0,
      tagIndex: 0,
    });
    this.updateFacetOptions();
    if (await this.refreshTags()) await this.load(true);
  },
  async search() {
    await this.load(true);
  },
  async load(reset = false) {
    const requestId = (this._requestId || 0) + 1;
    this._requestId = requestId;
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    try {
      const section = this.data.section;
      let result,
        summary = [];
      if (section === 'profile' || (section === 'library' && this.data.teacher)) result = { items: [], total: 0 };
      else if (section === 'bank')
        result = await l.request(
          '/api/question-bank/items?' +
            l.query({
              page,
              q: this.data.q,
              subject: this.data.subject,
              collection: this.data.collection,
              skill: this.data.skill,
              tag: this.data.tag,
              qualityStatus: this.data.usableOnly ? 'ready' : '',
              reviewRequired: this.data.usableOnly ? 'false' : this.data.reviewRequired,
            }),
        );
      else if (section === 'library')
        result = await l.request(
          '/api/library?' +
            l.query({
              page,
              q: this.data.q,
              includeProcessing: this.data.teacher ? 'true' : undefined,
            }),
        );
      else if (section === 'agents' || section === 'teacher') {
        result = await l.request(
          '/api/ai/agents?' +
            l.query({ page, mine: section === 'teacher' ? 'true' : undefined }),
        );
      } else if (section === 'history') {
        const route = this.data.agentId
          ? '/api/ai/teacher/agents/' + this.data.agentId + '/conversations'
          : '/api/ai/conversations';
        const rows = await l.request(
          route + '?' + l.query({ page, userId: this.data.userId }),
        );
        result = {
          items: rows,
          total:
            rows.length === 20 ? page * 20 + 1 : (page - 1) * 20 + rows.length,
        };
      } else {
        const route =
          this.data.scope === 'admin'
            ? '/api/ai/admin/usage'
            : this.data.scope === 'teacher'
              ? '/api/ai/teacher/usage'
              : '/api/ai/usage';
        const data = await l.request(
          route +
            '?' +
            l.query({
              page,
              agentId: this.data.agentId,
              userId: this.data.userId,
              from: this.data.from ? this.data.from + 'T00:00:00+08:00' : '',
              to: this.data.to ? this.data.to + 'T23:59:59.999+08:00' : '',
            }),
        );
        result = {
          items: data.items,
          total:
            data.items.length === 20
              ? page * 20 + 1
              : (page - 1) * 20 + data.items.length,
        };
        summary = data.summary;
      }
      if (requestId !== this._requestId) return;
      const mapped = result.items.map((x) => ({
        ...x,
        id: x.id || x.resourceId,
        thumbnailUrl: x.thumbnail ? l.url(x.thumbnail.path) : '',
        ...(section === 'usage' ? { usage: usageView.row(x) } : {}),
      }));
      const items = reset ? mapped : this.data.items.concat(mapped);
      const groups = new Map();
      if (section === 'bank') items.forEach(item => {
        const label = item.primary_tag_name || '其他题目';
        const key = (item.collection || item.collection_label || '') + ':' + (item.primary_tag || label);
        if (!groups.has(key)) groups.set(key, { key, label, items: [] });
        groups.get(key).items.push(item);
      });
      this.setData({
        items,
        questionGroups: Array.from(groups.values()),
        total: result.total,
        page,
        ...(section === 'usage' ? { usageOverview: usageView.overview(summary), usagePeriod: usageView.period(this.data.from, this.data.to) } : {}),
      });
    } catch (e) {
      l.error(e);
    } finally {
      if (requestId === this._requestId) this.setData({ loading: false });
    }
  },
  more() {
    if (!this.data.loading && this.data.items.length < this.data.total)
      return this.load();
  },
  openItem(e) {
    l.go(
      '/pages/question/detail?id=' +
        e.currentTarget.dataset.id +
        '&revisionId=' +
        e.currentTarget.dataset.revision +
        '&document=' +
        (this.data.section === 'library' ? '1' : '0'),
    );
  },
  create() {
    l.go('/pages/studio/studio');
  },
  edit(e) {
    l.go('/pages/studio/studio?id=' + e.currentTarget.dataset.id);
  },
  conversation(e) {
    l.go('/pages/chat/chat?id=' + e.currentTarget.dataset.id);
  },
  async uploadPublic() {
    try {
      const file = await l.pickFile();
      this.setData({ uploading: true });
      const doc = await l.upload('/api/library/upload', file);
      l.openDocument(doc);
    } catch (e) {
      if (!String(e.errMsg || '').includes('cancel')) l.error(e);
    } finally {
      this.setData({ uploading: false });
    }
  },
  async addText() {
    const { publicTitle, publicText, submittingText } = this.data;
    if (submittingText || !publicText.trim()) return;
    this.setData({ submittingText: true });
    try {
      const doc = await l.request('/api/library/text', 'POST', {
        title: publicTitle || '教学资料',
        text: publicText,
      });
      if (this.data.publicText === publicText && this.data.publicTitle === publicTitle)
        this.setData({ publicText: '', publicTitle: '' });
      l.openDocument(doc);
    } catch (e) {
      l.error(e);
    } finally {
      this.setData({ submittingText: false });
    }
  },
  async existing() {
    this.setData({ chooseExisting: !this.data.chooseExisting });
    if (this.data.chooseExisting) await this.loadExisting();
    else {
      this._existingFilesRequest = (this._existingFilesRequest || 0) + 1;
      this.setData({ existingLoading: false, existingLoaded: false, existingFiles: [] });
    }
  },
  async loadExisting() {
    const request = (this._existingFilesRequest || 0) + 1;
    this._existingFilesRequest = request;
    const category = this.data.category;
    this.setData({ existingLoading: true, existingLoaded: false, existingFiles: [] });
    try {
      const api = require('../../utils/api');
      const existingFiles = await api.files(category);
      if (request === this._existingFilesRequest) this.setData({ existingFiles, existingLoaded: true });
    } catch (e) {
      if (request === this._existingFilesRequest) l.error(e);
    } finally {
      if (request === this._existingFilesRequest) this.setData({ existingLoading: false });
    }
  },
  async category(e) {
    this.setData({
      category: ['A', 'B', 'C', 'D', 'E'][Number(e.detail.value)],
    });
    await this.loadExisting();
  },
  async indexFile(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.indexingFile || this.data.existingLoading || !this.data.existingFiles.some(file => String(file.id) === String(id))) return;
    this.setData({ indexingFile: id });
    try {
      const doc = await l.request(
        '/api/library/files/' + id + '/index',
        'POST',
      );
      l.openDocument(doc);
    } catch (e) {
      l.error(e);
    } finally {
      this.setData({ indexingFile: '' });
    }
  },
  scope(e) {
    this.setData({ scope: e.currentTarget.dataset.id, expandedUsageId: '',...(e.currentTarget.dataset.id === 'self' ? { userId: '' } : {}) });
    this.load(true);
  },
  toggleUsageFilters() { this.setData({ usageFiltersOpen: !this.data.usageFiltersOpen }); },
  toggleUsageDetails(e) { this.setData({ expandedUsageId: this.data.expandedUsageId === e.currentTarget.dataset.id ? '' : e.currentTarget.dataset.id }); },
  async applyUsageFilters() {
    if (this.data.from && this.data.to && this.data.from > this.data.to) {
      this.setData({ usageFilterError: '结束日期不能早于开始日期' });
      return;
    }
    this.setData({ usageFiltersOpen: false, usageFilterError: '', expandedUsageId: '' });
    await this.load(true);
  },
  async resetUsageFilters() {
    this.setData({ from: '', to: '', userId: '', usageFilterError: '', expandedUsageId: '' });
    await this.load(true);
  },
  date(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  logout() {
    const api = require('../../utils/api');
    const storage = require('../../utils/storage');
    wx.showModal({
      title: '退出登录',
      content: '退出后将返回登录页面；已记住的设备也会失效。',
      confirmText: '退出',
      success: async (result) => {
        if (!result.confirm) return;
        const rememberToken = storage.getRememberToken();
        try {
          await api.logout(rememberToken);
        } catch (error) {
          console.warn('后端退出失败，继续清理本地登录状态:', error);
        }
        storage.clearSession();
        wx.reLaunch({ url: '/pages/login/login' });
      },
    });
  },
}));
