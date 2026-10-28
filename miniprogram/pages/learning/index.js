const l = require('../../utils/learning');
const workspace = require('../../utils/workspace');
Page({
  data: {
    section: 'bank',
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
    sections: [
      { id: 'bank', name: '题库' },
      { id: 'agents', name: '教学助手' },
      { id: 'library', name: '公共教学资料' },
      { id: 'history', name: '会话历史' },
      { id: 'usage', name: '费用统计' },
    ],
    user: {},
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
    qualityStatus: '',
    reviewRequired: '',
    subjects: [{ id: '', label: '全部学科' }],
    collections: [{ id: '', label: '全部数据集' }],
    skills: [{ id: '', label: '全部技能' }],
    tags: [{ code: '', label: '全部标签' }],
    subjectIndex: 0,
    collectionIndex: 0,
    skillIndex: 0,
    tagIndex: 0,
    summary: [],
    scope: 'self',
    agentId: '',
    from: '',
    to: '',
    userId: '',
    publicText: '',
    publicTitle: '',
    uploading: false,
    existingFiles: [],
    category: 'A',
    chooseExisting: false,
  },
  onLoad(options) {
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
      const sections = [...this.data.sections];
      if (me.user.role === 'teacher')
        sections.push({ id: 'teacher', name: '我的教学助手' });
      this.setData({
        user: me.user,
        admin: me.admin,
        teacher: me.user.role === 'teacher',
        sections,
      });
      this._ready = true;
      if (this.data.section === 'library' && this.data.teacher) {
        this.setData({ section: 'profile', mainTab: 'profile', sectionTitle: '个人中心' });
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
  back() {
    wx.navigateBack();
  },
  home() { wx.reLaunch({ url: '/pages/home/home' }); },
  openAdmin() {
    l.go('/pages/admin/admin');
  },
  tabFor(section) {
    return ['agents', 'history'].includes(section) ? 'chat' : section === 'bank' ? 'bank' : 'profile';
  },
  titleFor(section) {
    return { bank: '题库', agents: '学习助手', history: '会话历史', profile: '个人中心', library: '公共教学资料', teacher: '我的教学助手', usage: '用量与费用' }[section] || '学习工作台';
  },
  toggleDrawer() { this.setData({ drawerOpen: !this.data.drawerOpen }); },
  closeDrawer() { this.setData({ drawerOpen: false }); },
  toggleFilters() { this.setData({ filtersOpen: !this.data.filtersOpen }); },
  async loadRecent(append = false) {
    if (append && (this.data.recentLoading || !this.data.recentHasMore)) return;
    const requestId = (this._recentRequestId || 0) + 1;
    this._recentRequestId = requestId;
    const page = append ? this.data.recentPage + 1 : 1;
    this.setData({ recentLoading: true });
    try {
      const rows = await l.request('/api/ai/conversations?' + l.query({ page }));
      if (requestId !== this._recentRequestId) return;
      const unique = new Map((append ? this.data.recentConversations : []).concat(rows).map(row => [row.id, row]));
      const recentConversations = Array.from(unique.values());
      this.setData({ recentConversations, recentPage: page, recentHasMore: rows.length === 20,
        conversationGroups: workspace.groupConversations(recentConversations, this.data.conversationGroups, this.data.conversation && this.data.conversation.agent_id) });
    } catch (e) { if (requestId === this._recentRequestId) l.error(e); }
    finally { if (requestId === this._recentRequestId) this.setData({ recentLoading: false }); }
  },
  moreRecent() { return this.loadRecent(true); },
  toggleAgentGroup(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ conversationGroups: this.data.conversationGroups.map(group => group.id === id ? { ...group, expanded: !group.expanded } : group) });
  },
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
      mainTab: this.tabFor(section),
      sectionTitle: this.titleFor(section),
      drawerOpen: false,
      items: [],
      questionGroups: [],
      agentId: '',
      scope: 'self',
      q: this._queries[section] || '',
    });
    if (section === 'bank' && this._tagsPending && !(await this.refreshTags())) return;
    await this.load(true);
    if (this.data.mainTab === 'chat') await this.loadRecent();
  },
  async openLibraryManager() {
    if (this.data.startingChat) return;
    this.setData({ startingChat: true });
    try {
      const conversation = await l.request('/api/ai/library-manager/conversation', 'POST', {});
      l.go('/pages/chat/chat?id=' + encodeURIComponent(conversation.id));
      this.closeDrawer();
    } catch (e) { l.error(e); }
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
    this.setData({ subject: subject.id, subjectLabel: subject.label, subjectIndex: index, collection: '', skill: '', tag: '', q: '', collectionIndex: 0, skillIndex: 0, tagIndex: 0, reviewRequired: '', drawerOpen: false, items: [], questionGroups: [], page: 1 });
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
    this.setData({ reviewRequired: e.detail.value ? 'true' : '' });
    this.load(true);
  },
  async clear() {
    this.setData({
      q: '',
      collection: '',
      skill: '',
      tag: '',
      reviewRequired: '',
      collectionIndex: 0,
      skillIndex: 0,
      tagIndex: 0,
      tags: [{ code: '', label: '全部标签' }],
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
      if (section === 'profile') result = { items: [], total: 0 };
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
              reviewRequired: this.data.reviewRequired,
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
              from: this.data.from,
              to: this.data.to,
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
        dataText: x.data ? JSON.stringify(x.data) : '',
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
        summary,
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
  async startAgent(e) {
    try {
      const conv = await l.request('/api/ai/conversations', 'POST', {
        agentId: e.currentTarget.dataset.id,
      });
      l.go('/pages/chat/chat?id=' + conv.id);
    } catch (e) {
      l.error(e);
    }
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
      l.go(
        '/pages/question/detail?id=' +
          doc.resourceId +
          '&revisionId=' +
          doc.revisionId +
          '&document=1',
      );
    } catch (e) {
      if (!String(e.errMsg || '').includes('cancel')) l.error(e);
    } finally {
      this.setData({ uploading: false });
    }
  },
  async addText() {
    try {
      if (!this.data.publicText.trim()) return;
      const doc = await l.request('/api/library/text', 'POST', {
        title: this.data.publicTitle || '教学资料',
        text: this.data.publicText,
      });
      this.setData({ publicText: '', publicTitle: '' });
      l.go(
        '/pages/question/detail?id=' +
          doc.resourceId +
          '&revisionId=' +
          doc.revisionId +
          '&document=1',
      );
    } catch (e) {
      l.error(e);
    }
  },
  async existing() {
    this.setData({ chooseExisting: !this.data.chooseExisting });
    if (this.data.chooseExisting) await this.loadExisting();
  },
  async loadExisting() {
    try {
      const api = require('../../utils/api');
      this.setData({ existingFiles: await api.files(this.data.category) });
    } catch (e) {
      l.error(e);
    }
  },
  async category(e) {
    this.setData({
      category: ['A', 'B', 'C', 'D', 'E'][Number(e.detail.value)],
    });
    await this.loadExisting();
  },
  async indexFile(e) {
    try {
      const doc = await l.request(
        '/api/library/files/' + e.currentTarget.dataset.id + '/index',
        'POST',
      );
      l.go(
        '/pages/question/detail?id=' +
          doc.resourceId +
          '&revisionId=' +
          doc.revisionId +
          '&document=1',
      );
    } catch (e) {
      l.error(e);
    }
  },
  scope(e) {
    this.setData({ scope: e.currentTarget.dataset.id });
    this.load(true);
  },
  date(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
});
