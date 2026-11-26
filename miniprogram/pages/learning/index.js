const l = require('../../utils/learning');
const storage = require('../../utils/storage');
const workspace = require('../../utils/workspace');
const usageView = require('../../utils/usage');
const drive = require('../../utils/drive');
const fileUtil = require('../../utils/file');
const cache = require('../../utils/cache');

const CACHE_TTL = {
  ME: 5 * 60 * 1000,
  FACETS: 5 * 60 * 1000,
  TAXONOMY: 5 * 60 * 1000,
  BANK: 60 * 1000,
  AGENTS: 60 * 1000,
  DRIVE: 30 * 1000,
  HISTORY: 30 * 1000,
  USAGE: 30 * 1000,
};
const markdown = require('../../utils/markdown');
Page({
  data: {
    section: 'bank',
    sectionReady: false,
    bankItemCount: 0,
    motionRevision: 0,
    mainTab: '',
    drawerOpen: false,
    filtersOpen: false,
    subjectLabel: '全部学科',
    sectionTitle: '',
    questionGroups: [],
    recentConversations: [],
    conversationGroups: [],
    recentPage: 1,
    recentHasMore: false,
    recentLoading: false,
    landingText: '',
    landingFiles: [],
    agentIndex: 0,
    startingChat: false,
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
    driveFolderId: '',
    driveBreadcrumbs: [],
    driveFolders: [],
    driveFiles: [],
    driveHideMarked: false,
    driveUploading: false,
    driveSheet: '',
    driveEditTitle: '',
    driveEditName: '',
    driveTree: [],
    driveMoveTarget: '',
    driveTrashFolders: [],
    driveTrashFiles: [],
    drivePreviewTitle: '',
    drivePreviewContent: '',
    drivePreviewRenderText: '',
    drivePreviewIsMarkdown: false,
    drivePreviewFile: null,
  },
  openTeacherManagement() {
    if (this.data.teacher) l.go('/pages/accounts/accounts');
  },
  onResize() { this.setData({ navigationStyle: workspace.navigationStyle(wx) }); },
  onLoad(options = {}) {
    if (!l.guard()) {
      this.setData({ navigationStyle: workspace.navigationStyle(wx) });
      return;
    }
    this._targetPresetKey = options.presetKey || '';
    const rawSection = options.section || 'agents';
    const section = rawSection === 'chat' ? 'agents' : rawSection;
    this.setData({
      navigationStyle: workspace.navigationStyle(wx),
      section,
      mainTab: this.tabFor(section),
      sectionTitle: this.titleFor(section),
      sectionReady: true,
      agentId: options.agentId || '',
      scope: options.scope || 'self',
    });
    this.initialize();
  },
  onShow() {
    if (
      this._ready &&
      !this.data.loading &&
      Date.now() - (this._lastLoadedAt || 0) > 60000
    ) {
      this.load(true, { force: true, background: true });
    }
  },
  applyMe(me, section) {
    if (!me?.user) return;
    this.setData({
      user: me.user,
      admin: me.admin,
      teacher: me.user.role === 'teacher',
      section,
      mainTab: this.tabFor(section),
      sectionTitle: this.titleFor(section),
    });
  },
  async initialize() {
    try {
      const section = this.data.section === 'chat' ? 'agents' : this.data.section;
      const facetsPromise = section === 'bank' ? this.facets() : Promise.resolve();
      await l.getMe((me) => {
        this.applyMe(me, this._ready ? this.data.section : section);
        this._ready = true;
      });
      if (section === 'bank') {
        await facetsPromise;
        if (!this.data.subject && this.data.subjects.length > 1) {
          await this.selectSubject({ currentTarget: { dataset: { index: 1 } } });
        } else {
          await this.load(true);
        }
      } else {
        await Promise.all([
          this.load(true),
          this.tabFor(section) === 'chat' ? this.loadRecent() : Promise.resolve(),
        ]);
      }
    } catch (e) {
      l.error(e);
    }
  },
  home() { if (this.data.teacher) l.go('/pages/home/home'); },
  openAddQuestionMenu() {
    if (!this.data.teacher) return;
    wx.showActionSheet({
      itemList: ['AI 导入', '人工导入（单题）', 'ZIP 导入'],
      success: (res) => {
        if (res.tapIndex === 0) this.selectAgentPreset('question_curator');
        else if (res.tapIndex === 1) l.go('/pages/home/home?action=new');
        else if (res.tapIndex === 2) l.go('/pages/home/home?action=zip');
      },
    });
  },
  openAgentPresets() { if (this.data.teacher) l.go('/pages/studio/studio'); },
  openAdmin() {
    l.go('/pages/admin/admin');
  },
  tabFor(section) {
    return ['agents', 'teacher', 'history'].includes(section) ? 'chat' : ['bank', 'library'].includes(section) ? section : 'profile';
  },
  titleFor(section) {
    return { bank: '题库', agents: '学习助手', history: '会话历史', profile: '个人中心', library: '资料网盘', teacher: '我的教学助手', usage: '用量与费用' }[section] || '学习工作台';
  },
  ...workspace.drawer,
  toggleFilters() { this.setData({ filtersOpen: !this.data.filtersOpen }); },
  ...workspace.recentMethods(l),
  async selectMain(e) {
    const id = e.currentTarget.dataset.id;
    const section = id === 'chat' ? 'agents' : id;
    await this.selectSection({ currentTarget: { dataset: { id: section } } });
  },
  async selectAgentPreset(presetKey) {
    this._targetPresetKey = presetKey || '';
    await this.selectSection({ currentTarget: { dataset: { id: 'agents' } } });
  },
  backSection() {
    if (this.data.section === 'library' && this.data.driveFolderId) {
      return this.driveGoUp();
    }
    const target = this.data.section === 'usage' ? 'profile' : 'agents';
    return this.selectSection({ currentTarget: { dataset: { id: target } } });
  },
  sectionCacheSpec(section, overrides = {}) {
    const q = overrides.q !== undefined ? overrides.q : this.data.q;
    if (section === 'bank') {
      const subject = overrides.subject !== undefined ? overrides.subject : this.data.subject;
      const collection = overrides.collection !== undefined ? overrides.collection : this.data.collection;
      const skill = overrides.skill !== undefined ? overrides.skill : this.data.skill;
      const tag = overrides.tag !== undefined ? overrides.tag : this.data.tag;
      return {
        key: 'bank:items:' + l.query({ q, subject, collection, skill, tag }),
        maxAge: CACHE_TTL.BANK,
        persist: !q,
      };
    }
    if (section === 'library') {
      const folderId = overrides.driveFolderId !== undefined ? overrides.driveFolderId : this.data.driveFolderId;
      const hideMarked = overrides.driveHideMarked !== undefined ? overrides.driveHideMarked : this.data.driveHideMarked;
      return {
        key: 'drive:items:' + l.query({ folderId, q, hideMarked: hideMarked ? 'true' : '' }),
        maxAge: CACHE_TTL.DRIVE,
        persist: !folderId && !q && !hideMarked,
      };
    }
    if (section === 'agents') {
      return { key: 'agents:list:all', maxAge: CACHE_TTL.AGENTS, persist: true };
    }
    if (section === 'teacher') {
      return { key: 'agents:list:mine', maxAge: CACHE_TTL.AGENTS, persist: false };
    }
    if (section === 'history') {
      const agentId = overrides.agentId !== undefined ? overrides.agentId : this.data.agentId;
      const userId = overrides.userId !== undefined ? overrides.userId : this.data.userId;
      return { key: 'history:' + l.query({ agentId, userId }), maxAge: CACHE_TTL.HISTORY, persist: false };
    }
    if (section === 'usage') {
      const scope = overrides.scope !== undefined ? overrides.scope : this.data.scope;
      const agentId = overrides.agentId !== undefined ? overrides.agentId : this.data.agentId;
      const userId = overrides.userId !== undefined ? overrides.userId : this.data.userId;
      const from = overrides.from !== undefined ? overrides.from : this.data.from;
      const to = overrides.to !== undefined ? overrides.to : this.data.to;
      return { key: 'usage:' + scope + ':' + l.query({ agentId, userId, from, to }), maxAge: CACHE_TTL.USAGE, persist: false };
    }
    return null;
  },
  applySectionSnapshot(section, snapshot) {
    if (!snapshot) return {};
    if (section === 'bank') {
      this._bankItems = snapshot.items || [];
      return {
        bankItemCount: snapshot.bankItemCount || 0,
        questionGroups: snapshot.questionGroups || [],
        total: snapshot.total || 0,
        page: snapshot.page || 1,
      };
    }
    if (section === 'library') {
      return {
        driveBreadcrumbs: snapshot.driveBreadcrumbs || [],
        driveFolders: snapshot.driveFolders || [],
        driveFiles: snapshot.driveFiles || [],
      };
    }
    if (section === 'usage') {
      return {
        items: snapshot.items || [],
        questionGroups: [],
        total: snapshot.total || 0,
        page: snapshot.page || 1,
        usageOverview: snapshot.usageOverview || this.data.usageOverview,
        usagePeriod: snapshot.usagePeriod || this.data.usagePeriod,
      };
    }
    const update = {
      items: snapshot.items || [],
      questionGroups: [],
      total: snapshot.total || 0,
      page: snapshot.page || 1,
    };
    const idx = this.resolveTargetAgentIndex(section, snapshot.items || []);
    if (idx >= 0) update.agentIndex = idx;
    return update;
  },
  resolveTargetAgentIndex(section, items) {
    if (section !== 'agents' || !this._targetPresetKey) return -1;
    const key = this._targetPresetKey;
    this._targetPresetKey = '';
    return items.findIndex(x => x.preset_key === key || (key === 'question_curator' && (String(x.name || '').includes('题库整理') || x.tool_permission === 'read_write')));
  },
  async selectSection(e) {
    const section = e.currentTarget.dataset.id;
    // Search belongs to its content area; preserve bank filters across tabs.
    this._requestId = (this._requestId || 0) + 1;
    this._queries = this._queries || {};
    this._queries[this.data.section] = this.data.q;
    this._facetRequestId = (this._facetRequestId || 0) + 1;
    const nextQ = this._queries[section] || '';
    const spec = this.sectionCacheSpec(section, { q: nextQ, agentId: '', scope: 'self' });
    const cached = spec ? cache.get(spec.key, { maxAge: spec.maxAge }) : null;
    if (cached) {
      this.setData({
        section,
        sectionReady: true,
        motionRevision: this.data.motionRevision + 1,
        mainTab: this.tabFor(section),
        sectionTitle: this.titleFor(section),
        drawerOpen: false,
        agentId: '',
        scope: 'self',
        q: nextQ,
        loading: false,
        ...this.applySectionSnapshot(section, cached.value),
      });
    } else {
      this._bankItems = [];
      this.setData({
        section,
        sectionReady: true,
        bankItemCount: 0,
        motionRevision: this.data.motionRevision + 1,
        mainTab: this.tabFor(section),
        sectionTitle: this.titleFor(section),
        drawerOpen: false,
        items: [],
        questionGroups: [],
        ...(section === 'library' ? { driveFolders: [], driveFiles: [] } : {}),
        agentId: '',
        scope: 'self',
        q: nextQ,
      });
    }
    if (section === 'bank' && !this._facets) await this.facets();
    if (section === 'bank' && this._tagsPending && !(await this.refreshTags())) return;
    await this.load(true, { background: Boolean(cached), alreadyHydrated: Boolean(cached) });
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
    } catch (e) { l.error(e); }
    finally { this.setData({ startingChat: false }); }
  },
  chooseAgent(e) { this.setData({ agentIndex: Number(e.detail.value) }); },
  async attachLandingFiles() {
    if (this.data.startingChat) return;
    try {
      const picked = await l.pickFiles(true);
      if (!picked || !picked.length) return;
      const existing = this.data.landingFiles || [];
      const remaining = Math.max(0, 9 - existing.length);
      if (!remaining) {
        wx.showToast({ title: '最多附带 9 个文件', icon: 'none' });
        return;
      }
      const next = picked.slice(0, remaining).map((f) => ({
        id: l.id(),
        path: f.path,
        name: f.name || '未命名文件',
      }));
      this.setData({ landingFiles: existing.concat(next) });
    } catch (e) {
      if (!String(e?.errMsg || '').includes('cancel')) l.error(e);
    }
  },
  removeLandingFile(e) {
    if (this.data.startingChat) return;
    const index = Number(e.currentTarget.dataset.index);
    const files = (this.data.landingFiles || []).filter((_, i) => i !== index);
    this.setData({ landingFiles: files });
  },
  async startChat() {
    const agent = this.data.items[this.data.agentIndex];
    if (!agent || this.data.startingChat) return;
    this.setData({ startingChat: true });
    try {
      const conv = await l.request('/api/ai/conversations', 'POST', { agentId: agent.id });
      cache.invalidate('recent:conversations');
      cache.invalidate('history:');
      const pendingFiles = this.data.landingFiles || [];
      const uploadedIds = [];
      const failedNames = [];
      for (const file of pendingFiles) {
        try {
          const uploaded = await l.upload('/api/ai/conversations/' + conv.id + '/assets', file);
          if (uploaded && uploaded.resourceId) uploadedIds.push(uploaded.resourceId);
        } catch {
          failedNames.push(file.name || '未命名文件');
        }
      }
      if (failedNames.length) {
        wx.showToast({ title: '部分文件上传失败：' + failedNames.join('、'), icon: 'none' });
      }
      const landingText = this._landingText !== undefined ? this._landingText : this.data.landingText;
      if (!uploadedIds.length && !String(landingText || '').trim() && pendingFiles.length) {
        return;
      }
      const url =
        '/pages/chat/chat?id=' +
        encodeURIComponent(conv.id) +
        '&initialText=' +
        encodeURIComponent(landingText) +
        (uploadedIds.length ? '&initialAssets=' + encodeURIComponent(uploadedIds.join(',')) : '');
      l.go(url);
      this._landingText = '';
      this.setData({ landingText: '', landingFiles: [] });
    } catch (e) { l.error(e); }
    finally { this.setData({ startingChat: false }); }
  },
  input(e) {
    const field = e.currentTarget.dataset.field;
    if (field === 'landingText') {
      this._landingText = e.detail.value;
      return;
    }
    this.setData({ [field]: e.detail.value });
  },
  applyFacets(found) {
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
  async facets(force = false) {
    const cached = !force ? cache.get('bank:facets', { maxAge: CACHE_TTL.FACETS }) : null;
    if (cached) {
      this.applyFacets(cached.value);
      if (cached.fresh) return;
      l.request('/api/question-bank/facets').then((found) => {
        cache.set('bank:facets', found, { persist: true });
        this.applyFacets(found);
      }).catch(() => {});
      return;
    }
    const found = await l.request('/api/question-bank/facets');
    cache.set('bank:facets', found, { persist: true });
    this.applyFacets(found);
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
  async refreshTags(force = false) {
    const requestId = (this._facetRequestId || 0) + 1;
    this._facetRequestId = requestId;
    this._tagsPending = true;
    this._requestId = (this._requestId || 0) + 1;
    const collections = this.data.collections.filter(x => x.id && (!this.data.collection || x.id === this.data.collection));
    const hasFilter = Boolean(this.data.subject || this.data.collection);
    const cachedEntries = (!force && hasFilter) ? collections.map(c => cache.get('bank:taxonomy:' + c.id, { maxAge: CACHE_TTL.TAXONOMY })) : [];
    const allCached = hasFilter && collections.length > 0 && cachedEntries.every(Boolean);
    if (allCached) {
      const groups = collections.map((collection, idx) =>
        cachedEntries[idx].value.map(tag => ({ ...tag, key: collection.id + ':' + tag.code, collection: collection.id, displayLabel: collections.length > 1 ? tag.label + ' · ' + collection.label : tag.label })),
      );
      this._tagsPending = false;
      this.setData({ tags: [{ key: 'all', code: '', label: '全部', collection: '' }, ...groups.flat()], tagIndex: 0, loading: false });
      if (cachedEntries.every(e => e.fresh)) return true;
      Promise.all(collections.map(async collection => {
        const tags = await l.request('/api/question-bank/taxonomy?' + l.query({ collection: collection.id }));
        cache.set('bank:taxonomy:' + collection.id, tags, { persist: true });
        return tags.map(tag => ({ ...tag, key: collection.id + ':' + tag.code, collection: collection.id, displayLabel: collections.length > 1 ? tag.label + ' · ' + collection.label : tag.label }));
      })).then(freshGroups => {
        if (requestId !== this._facetRequestId) return;
        this.setData({ tags: [{ key: 'all', code: '', label: '全部', collection: '' }, ...freshGroups.flat()], tagIndex: 0 });
      }).catch(() => {});
      return true;
    }
    this.setData({ tags: [{ key: 'all', code: '', label: '全部', collection: '' }], tagIndex: 0, loading: true });
    try {
      const groups = hasFilter ? await Promise.all(collections.map(async collection => {
        const tags = await l.request('/api/question-bank/taxonomy?' + l.query({ collection: collection.id }));
        cache.set('bank:taxonomy:' + collection.id, tags, { persist: true });
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
    this._bankItems = [];
    this.setData({ subject: subject.id, subjectLabel: subject.label, collection: '', skill: '', tag: '', q: '', collectionIndex: 0, skillIndex: 0, tagIndex: 0, drawerOpen: false, items: [], bankItemCount: 0, questionGroups: [], page: 1 });
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
  async clear() {
    this.setData({
      q: '',
      collection: '',
      skill: '',
      tag: '',
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
  async load(reset = false, options = {}) {
    const requestId = (this._requestId || 0) + 1;
    this._requestId = requestId;
    const section = this.data.section;
    const spec = reset && section !== 'profile' ? this.sectionCacheSpec(section) : null;
    const cached = (spec && !options.force) ? cache.get(spec.key, { maxAge: spec.maxAge }) : null;
    if (cached) {
      if (!options.alreadyHydrated) {
        this.setData({
          ...this.applySectionSnapshot(section, cached.value),
          loading: false,
        });
      }
      if (cached.fresh) {
        this._lastLoadedAt = cached.updatedAt;
        return;
      }
    }
    const page = reset ? 1 : this.data.page + 1;
    if (!cached && !options.background) this.setData({ loading: true });
    try {
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
            }),
        );
      else if (section === 'library') {
        const data = await l.request(
          '/api/drive/items?' +
            l.query({
              folderId: this.data.driveFolderId,
              q: this.data.q,
              hideMarked: this.data.driveHideMarked ? 'true' : '',
            }),
        );
        if (requestId !== this._requestId) return;
        const driveSnapshot = {
          driveBreadcrumbs: data.breadcrumbs || [],
          driveFolders: data.folders || [],
          driveFiles: (data.files || []).map(f => ({
            ...f,
            sizeLabel: drive.formatSize(f.file_size),
            timeLabel: fileUtil.formatDate(f.created_at),
          })),
        };
        if (spec) cache.set(spec.key, driveSnapshot, { persist: spec.persist });
        this.setData({
          ...driveSnapshot,
          loading: false,
        });
        this._lastLoadedAt = Date.now();
        return;
      }
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
        const requester = this.data.scope === 'admin' ? l.managementRequest : l.request;
        const data = await requester(
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
      const prevItems = section === 'bank' ? (this._bankItems || []) : this.data.items;
      const items = reset ? mapped : prevItems.concat(mapped);
      const groups = new Map();
      if (section === 'bank') {
        this._bankItems = items;
        items.forEach(item => {
          const label = item.primary_tag_name || '其他题目';
          const key = (item.collection || item.collection_label || '') + ':' + (item.primary_tag || label);
          if (!groups.has(key)) groups.set(key, { key, label, items: [] });
          groups.get(key).items.push(item);
        });
      }
      const questionGroups = Array.from(groups.values());
      const usageOverview = section === 'usage' ? usageView.overview(summary) : undefined;
      const usagePeriod = section === 'usage' ? usageView.period(this.data.from, this.data.to) : undefined;
      if (reset && spec) {
        if (section === 'bank') {
          cache.set(spec.key, { items, bankItemCount: items.length, questionGroups, total: result.total, page }, { persist: spec.persist });
        } else if (section === 'usage') {
          cache.set(spec.key, { items, total: result.total, page, usageOverview, usagePeriod }, { persist: false });
        } else {
          cache.set(spec.key, { items, total: result.total, page }, { persist: spec.persist });
        }
      }
      const update = {
        ...(section === 'bank'
          ? { bankItemCount: items.length, questionGroups }
          : { items, questionGroups: [] }),
        total: result.total,
        page,
        ...(section === 'usage' ? { usageOverview, usagePeriod } : {}),
      };
      const idx = this.resolveTargetAgentIndex(section, items);
      if (idx >= 0) update.agentIndex = idx;
      this.setData(update);
      this._lastLoadedAt = Date.now();
    } catch (e) {
      if (requestId === this._requestId) l.error(e);
    } finally {
      if (requestId === this._requestId) this.setData({ loading: false });
    }
  },
  more() {
    const loadedCount = this.data.section === 'bank' ? (this.data.bankItemCount || 0) : this.data.items.length;
    if (!this.data.loading && loadedCount < this.data.total)
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
  openDriveFolder(e) {
    const id = e.currentTarget.dataset.id || '';
    this.setData({ driveFolderId: id ? String(id) : '', q: '' });
    this.load(true);
  },
  driveGoUp() {
    const crumbs = this.data.driveBreadcrumbs || [];
    const parent = crumbs.length >= 2 ? crumbs[crumbs.length - 2] : null;
    this.setData({ driveFolderId: parent ? String(parent.id) : '', q: '' });
    return this.load(true);
  },
  toggleDriveHideMarked(e) {
    this.setData({ driveHideMarked: Boolean(e.detail.value) });
    this.load(true);
  },
  async toggleDriveMark(e) {
    const id = e.currentTarget.dataset.id;
    const marked = Boolean(e.currentTarget.dataset.marked);
    try {
      await l.request('/api/marks/' + id, marked ? 'DELETE' : 'PUT', {});
      cache.invalidate('drive:items:');
      await this.load(true, { force: true });
    } catch (err) { l.error(err); }
  },
  openDriveFilePreview(file) {
    if (!file) return;
    drive.previewFile(file, {
      onTextPreview: ({ title, content, file: f, isMarkdown }) => {
        const md = Boolean(isMarkdown);
        this.setData({
          driveSheet: 'text',
          drivePreviewTitle: title,
          drivePreviewContent: content,
          drivePreviewIsMarkdown: md,
          drivePreviewRenderText: md ? markdown.prepareMarkdown(content) : '',
          drivePreviewFile: f,
        });
      },
    });
  },
  previewDriveFile(e) {
    const file = this.data.driveFiles[e.currentTarget.dataset.index];
    if (file) this.openDriveFilePreview(file);
  },
  copyDrivePreview() {
    if (!this.data.drivePreviewContent) return;
    wx.setClipboardData({ data: this.data.drivePreviewContent });
  },
  downloadDrivePreview() {
    const file = this.data.drivePreviewFile;
    if (!file) return;
    drive.downloadAndSave('/api/drive/files/' + file.id + '/download', file.original_name);
  },
  async driveUpload() {
    if (this.data.driveUploading) return;
    try {
      const files = await drive.chooseUploadFiles();
      if (!files.length) return;
      this.setData({ driveUploading: true });
      for (const f of files) {
        await drive.uploadFile(this.data.driveFolderId, f);
      }
      wx.showToast({ title: '上传成功' });
      cache.invalidate('drive:items:');
      await this.load(true, { force: true });
    } catch (err) {
      if (!String(err?.errMsg || '').includes('cancel')) l.error(err);
    } finally {
      this.setData({ driveUploading: false });
    }
  },
  exportDriveFolder() {
    if (!this.data.driveFolderId) return;
    const last = this.data.driveBreadcrumbs[this.data.driveBreadcrumbs.length - 1];
    drive.downloadAndSave('/api/drive/folders/' + this.data.driveFolderId + '/export', (last?.name || '资料') + '.zip');
  },
  openDriveNewFolder() {
    this._driveEdit = { mode: 'create-folder' };
    this.setData({ driveSheet: 'name', driveEditTitle: '新建文件夹', driveEditName: '' });
  },
  closeDriveSheet() {
    this.setData({ driveSheet: '', driveEditName: '', drivePreviewTitle: '', drivePreviewContent: '', drivePreviewRenderText: '', drivePreviewIsMarkdown: false, drivePreviewFile: null });
  },
  async submitDriveName() {
    const name = this.data.driveEditName.trim();
    if (!name) return;
    try {
      const ctx = this._driveEdit || {};
      if (ctx.mode === 'create-folder') {
        await l.request('/api/drive/folders', 'POST', { parentId: this.data.driveFolderId || null, name });
        wx.showToast({ title: '文件夹已创建', icon: 'success' });
      } else if (ctx.mode === 'rename-folder') {
        await l.request('/api/drive/folders/' + ctx.id, 'PATCH', { name });
      } else if (ctx.mode === 'rename-file') {
        await l.request('/api/drive/files/' + ctx.id, 'PATCH', { name });
      }
      this.closeDriveSheet();
      cache.invalidate('drive:items:');
      await this.load(true, { force: true });
    } catch (err) { l.error(err); }
  },
  async openMoveSheet(type, item) {
    try {
      const data = await l.request('/api/drive/tree');
      const flat = [];
      const byParent = new Map();
      for (const row of data.folders || []) {
        const key = row.parent_id ? String(row.parent_id) : 'root';
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(row);
      }
      const walk = (parentKey, depth) => {
        for (const node of byParent.get(parentKey) || []) {
          if (type === 'folder' && node.id === item.id) continue;
          flat.push({ ...node, indent: '　'.repeat(depth) });
          walk(String(node.id), depth + 1);
        }
      };
      walk('root', 0);
      this._driveMove = { type, id: item.id };
      this.setData({ driveSheet: 'move', driveTree: flat, driveMoveTarget: item.parent_id || item.folder_id || '' });
    } catch (err) { l.error(err); }
  },
  pickMoveTarget(e) {
    this.setData({ driveMoveTarget: e.currentTarget.dataset.id });
  },
  async submitDriveMove() {
    const ctx = this._driveMove;
    if (!ctx) return;
    try {
      const target = this.data.driveMoveTarget ? Number(this.data.driveMoveTarget) : null;
      if (ctx.type === 'folder') await l.request('/api/drive/folders/' + ctx.id, 'PATCH', { parentId: target });
      else await l.request('/api/drive/files/' + ctx.id, 'PATCH', { folderId: target });
      this.closeDriveSheet();
      cache.invalidate('drive:items:');
      await this.load(true, { force: true });
    } catch (err) { l.error(err); }
  },
  openDriveMenu(e) {
    const { type, index } = e.currentTarget.dataset;
    const item = type === 'folder' ? this.data.driveFolders[index] : this.data.driveFiles[index];
    if (!item) return;
    if (type === 'folder') {
      wx.showActionSheet({
        itemList: ['重命名', '移动到', '删除文件夹'],
        success: ({ tapIndex }) => {
          if (tapIndex === 0) {
            this._driveEdit = { mode: 'rename-folder', id: item.id };
            this.setData({ driveSheet: 'name', driveEditTitle: '重命名文件夹', driveEditName: item.name });
          } else if (tapIndex === 1) {
            this.openMoveSheet('folder', item);
          } else if (tapIndex === 2) {
            l.confirm(`将「${item.name}」及内部文件移入回收站？`, { title: '确认删除', confirmColor: '#a12540' })
              .then(async (ok) => {
                if (!ok) return;
                try { await l.request('/api/drive/folders/' + item.id, 'DELETE', {}); cache.invalidate('drive:items:'); await this.load(true, { force: true }); }
                catch (err) { l.error(err); }
              });
          }
        },
      });
      return;
    }
    const actions = ['预览', drive.isDesktop() ? '保存到本地' : '分享 / 发送'];
    if (item.canEdit) actions.push('重命名', '移动到', '删除文件');
    wx.showActionSheet({
      itemList: actions,
      success: ({ tapIndex }) => {
        if (tapIndex === 0) this.openDriveFilePreview(item);
        else if (tapIndex === 1) drive.downloadAndSave('/api/drive/files/' + item.id + '/download', item.original_name);
        else if (tapIndex === 2) {
          this._driveEdit = { mode: 'rename-file', id: item.id };
          this.setData({ driveSheet: 'name', driveEditTitle: '重命名文件', driveEditName: item.original_name });
        } else if (tapIndex === 3) {
          this.openMoveSheet('file', item);
        } else if (tapIndex === 4) {
          l.confirm(`将「${item.original_name}」移入回收站？`, { title: '确认删除', confirmColor: '#a12540' })
            .then(async (ok) => {
              if (!ok) return;
              try { await l.request('/api/drive/files/' + item.id, 'DELETE', {}); cache.invalidate('drive:items:'); await this.load(true, { force: true }); }
              catch (err) { l.error(err); }
            });
        }
      },
    });
  },
  async openDriveTrash() {
    try {
      const data = await l.request('/api/drive/trash');
      this.setData({ driveSheet: 'trash', driveTrashFolders: data.folders || [], driveTrashFiles: data.files || [] });
    } catch (err) { l.error(err); }
  },
  async restoreDriveTrash(e) {
    const { type, id } = e.currentTarget.dataset;
    try {
      await l.request('/api/drive/trash/restore', 'POST', { type, id });
      wx.showToast({ title: '已恢复' });
      await this.openDriveTrash();
      cache.invalidate('drive:items:');
      await this.load(true, { force: true });
    } catch (err) { l.error(err); }
  },
  async purgeDriveTrash(e) {
    const { type, id } = e.currentTarget.dataset;
    if (!(await l.confirm('彻底删除后将清除物理文件且无法恢复，确认继续？', { title: '彻底删除', confirmColor: '#a12540' }))) return;
    try {
      await l.request('/api/drive/trash/' + type + '/' + id, 'DELETE', {});
      cache.invalidate('drive:items:');
      wx.showToast({ title: '已彻底删除' });
      await this.openDriveTrash();
    } catch (err) { l.error(err); }
  },
  async logout() {
    if (!(await l.confirm('退出后将返回登录页面；已记住的设备也会失效。', { title: '退出登录', confirmText: '退出' }))) return;
    const rememberToken = storage.getRememberToken();
    try {
      await require('../../utils/api').logout(rememberToken);
    } catch (error) {
      console.warn('后端退出失败，继续清理本地登录状态:', error);
    }
    storage.clearSession();
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
