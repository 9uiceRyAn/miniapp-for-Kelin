const workspace = require('../../utils/workspace');
const withInputHints = require('../../utils/input-hints');
const drive = require('../../utils/drive');
// 题库管理：筛选题目、编辑修订、上传媒体、预览导入和删除恢复。
const l = require('../../utils/learning');
const states = [
  { value: 'active', label: '正常题目' },
  { value: 'deleted', label: '已删除' },
];
const kindNames = { question: '题目', answer: '答案', ms: '评分标准', sm: '参考解答', audio: '音频', source: '附件' };
const endpoint = '/api/question-bank/admin';
Page(withInputHints({
  data: {
    mainTab: 'profile', section: 'question-management', drawerOpen: false, safeTop: 0,
    teacher: false, admin: false, checking: true,
    items: [], total: 0, page: 1, loading: false, error: '', q: '',
    states, stateIndex: 0, subjects: [{ value: '', label: '全部学科' }], subjectIndex: 0,
    collections: [{ value: '', label: '全部数据集' }], collectionIndex: 0,
    formOpen: false, editingId: '', editingRevision: '', form: {}, formError: '', saving: false, uploading: false,
    formSubjects: [], formSubjectIndex: 0, formCollections: [], formCollectionIndex: 0,
    importPreview: null, importBusy: false, importResult: '',
    zipSheetOpen: false, downloadingSkill: false,
    batchMode: false, selectedCount: 0,
    taxonomyOpen: false, taxSubjects: [], taxCollections: [], taxTags: [], collectionTagOptions: [],
    newSubjectCode: '', newSubjectLabel: '', newColSubject: '', newColCode: '', newColLabel: '', newTagCol: '', newTagCode: '', newTagLabel: '',
    aiBusy: false, aiDrafts: [], aiAttachment: null,
  },
  onResize() { this.setData({ navigationStyle: workspace.navigationStyle(wx) }); },
  async onLoad(options = {}) {
    this.setData({ navigationStyle: workspace.navigationStyle(wx) });
    if (!l.guard()) return;
    try {
      const me = await l.request('/api/ai/me');
      const isTeacher = me.user.role === 'teacher';
      this.setData({ teacher: isTeacher, admin: isTeacher, checking: false });
      if (!isTeacher) return;
      await this.readFacets();
      await this.load(true);
      this._ready = true;
      if (options.action === 'new') this.newQuestion();
      else if (options.action === 'taxonomy') this.openTaxonomy();
      else if (options.action === 'zip') this.openZipImportSheet();
    } catch (error) { this.setData({ checking: false, error: error.message }); l.error(error); }
  },
  onShow() { if (this._ready) this.load(true); },
  onPullDownRefresh() {
    const refresh = this.data.admin ? this.readFacets().then(() => this.load(true)) : Promise.resolve();
    return refresh.finally(() => wx.stopPullDownRefresh());
  },
  ...workspace.drawer,
  ...workspace.profileNav,
  back() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.redirectTo({ url: '/pages/learning/index?section=profile' });
  },
  async readFacets() {
    const rows = await l.request(endpoint + '/facets');
    this._facets = rows;
    const map = new Map();
    for (const row of rows) map.set(row.subject, { value: row.subject, label: row.subjectLabel || row.subject });
    const subjects = [{ value: '', label: '全部学科' }, ...map.values()];
    const selected = this.data.subjects[this.data.subjectIndex]?.value;
    this.setData({ subjects, subjectIndex: Math.max(0, subjects.findIndex(x => x.value === selected)) });
    this.setCollections(this.data.collections[this.data.collectionIndex]?.value);
  },
  setCollections(selected = '') {
    const subject = this.data.subjects[this.data.subjectIndex]?.value;
    const map = new Map();
    for (const row of this._facets || []) if (!subject || row.subject === subject) map.set(row.collection, { value: row.collection, label: row.collectionLabel || row.collection });
    const collections = [{ value: '', label: '全部数据集' }, ...map.values()];
    this.setData({ collections, collectionIndex: Math.max(0, collections.findIndex(x => x.value === selected)) });
  },
  async load(reset = false) {
    if (!this.data.admin || (this.data.loading && !reset)) return;
    const request = (this._request || 0) + 1; this._request = request;
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '' });
    try {
      const result = await l.request(endpoint + '/items?' + l.query({
        q: this.data.q, subject: this.data.subjects[this.data.subjectIndex]?.value,
        collection: this.data.collections[this.data.collectionIndex]?.value,
        state: states[this.data.stateIndex].value, page,
      }));
      if (request !== this._request) return;
      const items = result.items.map(item => ({ ...item, thumbnailUrl: item.thumbnail ? l.url(item.thumbnail.path) : '', stateLabel: item.visibility === 'withdrawn' ? '已删除' : '' }));
      this.setData({ items: reset ? items : this.data.items.concat(items), total: result.total, page });
    } catch (error) { if (request === this._request) { this.setData({ error: error.message }); l.error(error); } }
    finally { if (request === this._request) this.setData({ loading: false }); }
  },
  searchInput(event) { this.setData({ q: event.detail.value }); },
  search() { return this.load(true); },
  filter(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ [field]: Number(event.detail.value) });
    if (field === 'subjectIndex') this.setCollections();
    return this.load(true);
  },
  more() { return this.load(false); },
  async openQuestion(event) {
    const item = this.data.items.find(x => x.resourceId === event.currentTarget.dataset.id);
    if (item && item.visibility !== 'withdrawn') l.go('/pages/question/detail?id=' + item.resourceId + '&revisionId=' + item.revisionId);
  },
  formOptions(subject, collection, item = {}) {
    const formSubjects = this.data.subjects.filter(x => x.value);
    if (!formSubjects.length) formSubjects.push({ value: 'general', label: '综合' });
    if (subject && !formSubjects.some(x => x.value === subject)) formSubjects.push({ value: subject, label: item.subject_label || subject });
    const formSubjectIndex = Math.max(0, formSubjects.findIndex(x => x.value === subject));
    const chosen = formSubjects[formSubjectIndex];
    const rows = (this._facets || []).filter(x => x.subject === chosen.value);
    const map = new Map(rows.map(x => [x.collection, { value: x.collection, label: x.collectionLabel || x.collection }]));
    const manual = 'manual-' + chosen.value.slice(0, 85);
    if (!map.has(manual)) map.set(manual, { value: manual, label: chosen.label + ' · 自建题库' });
    if (collection && !map.has(collection)) map.set(collection, { value: collection, label: item.collection_label || collection });
    const formCollections = [...map.values()];
    const formCollectionIndex = collection ? Math.max(0, formCollections.findIndex(x => x.value === collection)) : formCollections.findIndex(x => x.value === manual);
    this.setData({ formSubjects, formSubjectIndex, formCollections, formCollectionIndex });
  },
  openAddQuestionMenu() {
    if (!this.data.admin) return;
    wx.showActionSheet({
      itemList: ['AI 导入', '人工导入（单题）', 'ZIP 导入'],
      success: (res) => {
        if (res.tapIndex === 0) this.openCurator();
        else if (res.tapIndex === 1) this.newQuestion();
        else if (res.tapIndex === 2) this.openZipImportSheet();
      },
    });
  },
  openZipImportSheet() {
    if (!this.data.admin) return;
    this.setData({ zipSheetOpen: true, drawerOpen: false, error: '' });
  },
  closeZipImportSheet() {
    if (!this.data.importBusy) this.setData({ zipSheetOpen: false });
  },
  async downloadSkillBundle() {
    if (this.data.downloadingSkill) return;
    this.setData({ downloadingSkill: true });
    try {
      await drive.downloadAndSave('/api/question-bank/admin/skills/export', 'kelin-question-bank-skill.zip');
    } finally {
      this.setData({ downloadingSkill: false });
    }
  },
  async startZipImport() {
    this.setData({ zipSheetOpen: false });
    await this.importQuestions();
  },
  newQuestion() {
    if (!this.data.admin) return;
    this.formOptions(this.data.subjects[this.data.subjectIndex]?.value, '');
    this.setData({ inputHintFocus: '', formOpen: true, drawerOpen: false, editingId: '', editingRevision: '', formError: '',
      form: { title: '', sourceId: '', questionText: '', answerText: '', tagsText: '', attachments: [] } });
  },
  async editQuestion(event) {
    if (this.data.saving || this.data.uploading) return;
    try {
      const item = await l.request(endpoint + '/items/' + event.currentTarget.dataset.id);
      this.formOptions(item.subject, item.collection, item);
      this.setData({ inputHintFocus: '', formOpen: true, drawerOpen: false, editingId: item.resourceId, editingRevision: item.revisionId, formError: '',
        form: { title: item.title, sourceId: item.id, questionText: item.question_text || '', answerText: item.answer_text || '', tagsText: (item.tags || []).map(code => code + ' | ' + (item.tag_names?.[code] || code)).join('\n'), attachments: item.attachments.map(a => ({ ...a, key: a.id, name: a.label, kindLabel: kindNames[a.kind] || '附件', previewUrl: a.path ? l.url(a.path) : '' })) } });
    } catch (error) { l.error(error); }
  },
  closeForm() { if (!this.data.saving && !this.data.uploading) { this.resetInputHints(); this.setData({ formOpen: false, formError: '' }); } },
  formInput(event) { this.setData({ ['form.' + event.currentTarget.dataset.field]: event.detail.value }); },
  formPick(event) {
    const field = event.currentTarget.dataset.field;
    if (!this.data.editingId && field === 'formSubjectIndex') this.formOptions(this.data.formSubjects[Number(event.detail.value)].value, '');
    else if (!this.data.editingId) this.setData({ formCollectionIndex: Number(event.detail.value) });
  },
  async addAttachment(event) {
    if (this.data.uploading || this.data.saving) return;
    const kind = event.currentTarget.dataset.kind;
    try {
      const file = await l.pickFile(kind === 'question' || kind === 'answer');
      this.setData({ uploading: true, formError: '' });
      const staged = await l.upload(endpoint + '/uploads', file);
      const actualKind = staged.mime.startsWith('audio/') ? 'audio' : kind;
      this.setData({ 'form.attachments': this.data.form.attachments.concat({ ...staged, key: staged.token, label: staged.name, kind: actualKind, kindLabel: kindNames[actualKind], previewUrl: staged.mime.startsWith('image/') ? file.path : '' }) });
    } catch (error) { if (!String(error.errMsg || '').includes('cancel')) this.setData({ formError: error.message || '上传失败' }); }
    finally { this.setData({ uploading: false }); }
  },
  removeAttachment(event) {
    if (this.data.uploading || this.data.saving) return;
    this.setData({ 'form.attachments': this.data.form.attachments.filter((_, index) => index !== Number(event.currentTarget.dataset.index)) });
  },
  previewAttachment(event) {
    const attachment = this.data.form.attachments[Number(event.currentTarget.dataset.index)];
    if (attachment?.previewUrl && attachment.mime.startsWith('image/')) wx.previewImage({ current: attachment.previewUrl, urls: [attachment.previewUrl] });
  },
  async saveQuestion() {
    if (this.data.saving || this.data.uploading) return;
    const form = this.data.form;
    if (!form.title.trim()) { this.setData({ formError: '请填写题目标题' }); return; }
    const tags = [], tagNames = {};
    for (const line of form.tagsText.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
      const [code, ...name] = line.split('|').map(x => x.trim());
      if (!code) { this.setData({ formError: '知识点编号不能为空' }); return; }
      if (!tags.includes(code)) tags.push(code);
      Object.defineProperty(tagNames, code, { value: name.join(' | ') || code, enumerable: true, configurable: true });
    }
    const subject = this.data.formSubjects[this.data.formSubjectIndex], collection = this.data.formCollections[this.data.formCollectionIndex];
    this.setData({ saving: true, formError: '' });
    try {
      const id = this.data.editingId;
      await l.request(endpoint + '/items' + (id ? '/' + id : ''), id ? 'PATCH' : 'POST', {
        sourceId: form.sourceId, title: form.title, subject: subject.value, subjectLabel: subject.label, collection: collection.value, collectionLabel: collection.label,
        questionText: form.questionText, answerText: form.answerText, tags, tagNames,
        expectedRevisionId: this.data.editingRevision,
        attachments: form.attachments.map(a => ({ id: a.id, token: a.token, kind: a.kind, label: a.label })),
      });
      this.setData({ formOpen: false }); wx.showToast({ title: '题目已保存', icon: 'success' });
      await this.readFacets(); await this.load(true);
    } catch (error) { this.setData({ formError: error.message }); }
    finally { this.setData({ saving: false }); }
  },
  deleteQuestion(event) {
    const item = this.data.items.find(x => x.resourceId === event.currentTarget.dataset.id);
    if (!item) return;
    wx.showModal({ title: '删除题目', content: '确定删除“' + item.title + '”？删除后会从题库和检索中移除，可在“已删除”中恢复。', confirmText: '删除', confirmColor: '#a12540',
      success: async result => {
        if (!result.confirm) return;
        try { await l.request(endpoint + '/items/' + item.resourceId, 'DELETE', { expectedRevisionId: item.revisionId }); await this.load(true); wx.showToast({ title: '题目已删除', icon: 'success' }); }
        catch (error) { l.error(error); }
      } });
  },
  async restoreQuestion(event) {
    const item = this.data.items.find(x => x.resourceId === event.currentTarget.dataset.id);
    if (!item) return;
    try { await l.request(endpoint + '/items/' + item.resourceId + '/restore', 'POST', { expectedRevisionId: item.revisionId }); await this.load(true); wx.showToast({ title: '题目已恢复', icon: 'success' }); }
    catch (error) { l.error(error); }
  },
  async importQuestions() {
    if (this.data.importBusy) return;
    try {
      const file = await l.pickFile();
      this.setData({ importBusy: true, error: '', importResult: '' });
      const preview = await l.upload(endpoint + '/imports/preview', file);
      this.setData({ importPreview: preview });
    } catch (error) { if (!String(error.errMsg || '').includes('cancel')) this.setData({ error: error.message || '无法读取导入文件' }); }
    finally { this.setData({ importBusy: false }); }
  },
  async cancelImport() {
    if (this.data.importBusy || !this.data.importPreview) return;
    const token = this.data.importPreview.token;
    this.setData({ importPreview: null });
    try { await l.request(endpoint + '/imports/preview', 'DELETE', { token }); } catch (error) { if (error.statusCode !== 410) l.error(error); }
  },
  async confirmImport() {
    if (this.data.importBusy || !this.data.importPreview) return;
    this.setData({ importBusy: true, error: '' });
    try {
      const result = await l.request(endpoint + '/imports/confirm', 'POST', { token: this.data.importPreview.token });
      this.setData({ importPreview: null, importResult: '已处理 ' + result.items + ' 道题目 · 新增 ' + result.created + ' 道 · 新增修订 ' + result.revisions + ' 份 · 复用修订 ' + result.unchanged + ' 份' });
      await this.readFacets(); await this.load(true);
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ importBusy: false }); }
  },
  toggleBatchMode() {
    const batchMode = !this.data.batchMode;
    this.setData({
      batchMode,
      selectedCount: 0,
      items: this.data.items.map(x => ({ ...x, selected: false })),
    });
  },
  toggleSelectItem(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const items = this.data.items.map((x, i) => (i === idx ? { ...x, selected: !x.selected } : x));
    this.setData({ items, selectedCount: items.filter(x => x.selected).length });
  },
  async runBatch(e) {
    const action = e.currentTarget.dataset.action;
    const ids = this.data.items.filter(x => x.selected).map(x => x.resourceId);
    if (!ids.length) return;
    try {
      const res = await l.request(endpoint + '/items/batch', 'POST', { ids, action });
      wx.showToast({ title: `已完成 ${res.succeeded.length} 题` });
      this.setData({ batchMode: false, selectedCount: 0 });
      await this.load(true);
    } catch (err) { l.error(err); }
  },
  async openTaxonomy() {
    try {
      const data = await l.request(endpoint + '/taxonomy');
      this.setData({
        taxonomyOpen: true,
        taxSubjects: data.subjects || [],
        taxCollections: data.collections || [],
        taxTags: data.tags || [],
      });
    } catch (err) { l.error(err); }
  },
  closeTaxonomy() {
    this.setData({ taxonomyOpen: false });
  },
  taxInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  async addSubject() {
    try {
      await l.request(endpoint + '/subjects', 'POST', { code: this.data.newSubjectCode, label: this.data.newSubjectLabel });
      this.setData({ newSubjectCode: '', newSubjectLabel: '' });
      await this.openTaxonomy();
      await this.readFacets();
    } catch (err) { l.error(err); }
  },
  async addCollection() {
    try {
      await l.request(endpoint + '/collections', 'POST', { subjectCode: this.data.newColSubject, code: this.data.newColCode, label: this.data.newColLabel });
      this.setData({ newColCode: '', newColLabel: '' });
      await this.openTaxonomy();
      await this.readFacets();
    } catch (err) { l.error(err); }
  },
  async addTag() {
    try {
      await l.request(endpoint + '/tags', 'POST', { collectionCode: this.data.newTagCol, code: this.data.newTagCode, label: this.data.newTagLabel });
      this.setData({ newTagCode: '', newTagLabel: '' });
      await this.openTaxonomy();
    } catch (err) { l.error(err); }
  },
  async removeTaxItem(e) {
    const { kind, id } = e.currentTarget.dataset;
    try {
      await l.request(endpoint + '/' + kind + '/' + encodeURIComponent(id), 'DELETE', {});
      await this.openTaxonomy();
      await this.readFacets();
    } catch (err) { l.error(err); }
  },
  toggleFormTag(e) {
    const { code, label } = e.currentTarget.dataset;
    const lines = String(this.data.form.tagsText || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const existsIdx = lines.findIndex(line => line.split('|')[0].trim() === code);
    if (existsIdx >= 0) lines.splice(existsIdx, 1);
    else lines.push(`${code} | ${label}`);
    this.setData({ 'form.tagsText': lines.join('\n') });
  },
  async aiIngest() {
    if (this.data.aiBusy) return;
    try {
      const file = await l.pickFile(true);
      this.setData({ aiBusy: true });
      const res = await l.upload(endpoint + '/ai-ingest', file);
      this.setData({ aiDrafts: res.candidates || [], aiAttachment: res.attachment || null });
    } catch (err) {
      if (!String(err?.errMsg || '').includes('cancel')) l.error(err);
    } finally {
      this.setData({ aiBusy: false });
    }
  },
  closeAiDrafts() {
    this.setData({ aiDrafts: [], aiAttachment: null });
  },
  applyAiDraft(e) {
    const draft = this.data.aiDrafts[Number(e.currentTarget.dataset.index)];
    if (!draft) return;
    this.formOptions(this.data.subjects[this.data.subjectIndex]?.value, '');
    const att = this.data.aiAttachment ? [{ ...this.data.aiAttachment, key: this.data.aiAttachment.token, kindLabel: '题目' }] : [];
    this.setData({
      aiDrafts: [],
      aiAttachment: null,
      formOpen: true,
      editingId: '',
      editingRevision: '',
      form: {
        title: draft.title || '',
        sourceId: '',
        questionText: draft.questionText || '',
        answerText: draft.answerText || '',
        tagsText: (draft.tags || []).map(t => `${t} | ${t}`).join('\n'),
        attachments: att,
      },
    });
  },
  async openCurator() {
    const pages = getCurrentPages();
    const index = pages.map(p => p.route).lastIndexOf('pages/learning/index');
    if (index >= 0 && index < pages.length - 1) {
      await pages[index].selectAgentPreset('question_curator');
      wx.navigateBack({ delta: pages.length - 1 - index });
    } else {
      wx.redirectTo({ url: '/pages/learning/index?section=agents&presetKey=question_curator' });
    }
  },
}));
