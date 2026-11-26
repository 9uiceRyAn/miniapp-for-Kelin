const l = require('../../utils/learning');
const workspace = require('../../utils/workspace');
const markdown = require('../../utils/markdown');
const fileUtil = require('../../utils/file');
const cache = require('../../utils/cache');
const storage = require('../../utils/storage');

const CHAT_CACHE_TTL = 30 * 1000;
function renderInstant(message) {
  if (message.role !== 'assistant' || message.renderText !== undefined) return message;
  return { ...message, renderText: markdown.prepareMarkdown(message.data?.text || '') };
}
const toolNames = {
  propose_library_change: '准备资料操作',
  search_existing_files: '查找已有 A–E 资料',
  inspect_pdf_layout: '分析 PDF 题目边界',
  crop_attachment_image: '裁切题目图片',
  read_question_skill: '读取学科分类规范',
  list_taxonomy: '读取题库分类标签',
  get_question_detail: '读取题目详情',
  create_question: '录入新题到题库',
  create_question_draft: '录入新题到题库',
  propose_question_update: '准备改题确认卡片',
  propose_question_batch_update: '准备批量改题确认卡片',
  propose_taxonomy_change: '准备标签变更确认卡片',
  search_questions: '检索题库',
  search_library: '检索教学资料',
  get_question_image: '读取题图',
  read_library_resource: '读取资料',
  parse_file: '读取附件',
  read_image_text: '识别图片',
  calculate: '计算',
  web_search: '搜索网页',
};
Page({
  data: {
    mainTab: 'chat',
    section: 'chat',
    drawerOpen: false,
    recentConversations: [],
    conversationGroups: [],
    recentPage: 1,
    recentHasMore: false,
    recentLoading: false,
    id: '',
    conversation: null,
    teacher: false,
    libraryActions: [],
    questionActions: [],
    confirmingAction: '',
    applyingDraft: false,
    messages: [],
    assets: [],
    text: '',
    hasText: false,
    question: null,
    questionTitle: '',
    running: false,
    sending: false,
    runId: '',
    hasPartial: false,
    pendingText: '',
    streamHead: '',
    streamTail: '',
    streamTick: 0,
    progress: '',
    uploading: false,
    readOnly: false,
    error: '',
    hasOlder: false,
    loadingOlder: false,
  },
  onResize() { this.setData({ navigationStyle: workspace.navigationStyle(wx) }); },
  async onLoad(options) {
    this.setData({ navigationStyle: workspace.navigationStyle(wx) });
    if (!l.guard()) return;
    this._ownerId = storage.getUser()?.id;
    this.setData({ id: options.id, mainTab: options.mode === 'library' ? 'library' : 'chat' });
    this._visible = true;
    if (options.questionId) {
      try {
        const question = await l.request(
          '/api/question-bank/items/' +
            options.questionId +
            '/revisions/' +
            options.revisionId,
        );
        this.setData({
          question: {
            resourceId: question.resourceId,
            revisionId: question.revisionId,
          },
          questionTitle: question.title,
        });
      } catch (e) {
        l.error(e);
      }
    }
    const cached = options.id ? cache.get('chat:conv:' + options.id, { maxAge: CHAT_CACHE_TTL }) : null;
    if (cached) {
      this.setData(cached.value);
    }
    const recentPromise = this.loadRecent();
    await this.load();
    if (!this.draftKey()) return;
    let initialAssetIds = [];
    if (options.initialAssets) {
      let rawAssets = options.initialAssets;
      try { rawAssets = decodeURIComponent(rawAssets); }
      catch (e) { /* Keep raw value if not URI-encoded. */ }
      initialAssetIds = rawAssets.split(',').map(x => x.trim()).filter(Boolean);
    }
    if (!this.data.readOnly) {
      const draft = wx.getStorageSync(this.draftKey());
      if (draft || initialAssetIds.length) {
        const selectedSet = new Set([...(draft?.selectedAssets || []), ...initialAssetIds]);
        const draftText = draft?.text || '';
        this._text = draftText;
        this.setData({
          text: draftText,
          hasText: Boolean(draftText.trim()),
          ...(options.questionId ? {} : { question: draft?.question || null, questionTitle: draft?.questionTitle || '' }),
          assets: this.data.assets.map(asset => ({ ...asset, selected: selectedSet.has(asset.resourceId) })),
        });
      }
    }
    if ((options.initialText || initialAssetIds.length) && !this.data.readOnly) {
      let initialText = options.initialText || '';
      try { initialText = decodeURIComponent(initialText); }
      catch (e) { /* Already plain text can contain a literal percent sign. */ }
      this._text = initialText;
      this.setData({ text: initialText, hasText: Boolean(initialText.trim()) });
      await this.send();
    }
    await recentPromise;
  },
  onShow() {
    this._visible = true;
    if (
      this.data.conversation &&
      (this._wasRunningOnHide || Date.now() - (this._lastLoadedAt || 0) > 30000)
    ) {
      this._wasRunningOnHide = false;
      this.clearStreamBuffer();
      this.setData({ running: false, hasPartial: false, pendingText: '' });
      this.load();
    }
  },
  onHide() {
    const draftKey = this.draftKey();
    if (draftKey && this.data.id && !this.data.readOnly) {
      const currentText = this._text !== undefined ? this._text : this.data.text;
      wx.setStorageSync(draftKey, { text: currentText, question: this.data.question, questionTitle: this.data.questionTitle, selectedAssets: this.data.assets.filter(asset => asset.selected).map(asset => asset.resourceId) });
    }
    this._wasRunningOnHide = Boolean(this.data.running);
    this._visible = false;
    this.clearStreamBuffer();
    clearTimeout(this._timer);
    if (this._stream) this._stream.abort();
  },
  onUnload() {
    this.onHide();
  },
  back() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.redirectTo({ url: '/pages/learning/index?section=' + (this.data.mainTab === 'library' ? 'library' : 'agents') });
  },
  ...workspace.drawer,
  ...workspace.recentMethods(l, page => page.data.conversation?.agent_id),
  draftKey() {
    const id = storage.getUser()?.id;
    if (id == null || (this._ownerId != null && this._ownerId !== id)) return '';
    return 'learning-chat-draft:' + id + ':' + this.data.id;
  },
  async selectMain(e) {
    const id = e.currentTarget.dataset.id;
    if (id === this.data.mainTab) { this.closeDrawer(); return; }
    if (id === 'library') return this.selectSection(e);
    return workspace.returnToWorkspace(e, getCurrentPages(), wx);
  },
  openConnections() { l.go('/pages/admin/admin'); },
  async selectSection(e) {
    if (e.currentTarget.dataset.id === 'library' && this.data.teacher) {
      try {
        const conversation = await l.request('/api/ai/library-manager/conversation', 'POST', {});
        if (conversation.id === this.data.id) { this.closeDrawer(); return; }
        wx.redirectTo({ url: '/pages/chat/chat?id=' + encodeURIComponent(conversation.id) + '&mode=library' });
      } catch (e) { wx.redirectTo({ url: '/pages/learning/index?section=library' }); }
      return;
    }
    wx.redirectTo({ url: '/pages/learning/index?section=' + e.currentTarget.dataset.id });
  },
  conversation(e) {
    if (e.currentTarget.dataset.id === this.data.id) { this.closeDrawer(); return; }
    wx.redirectTo({ url: '/pages/chat/chat?id=' + e.currentTarget.dataset.id });
  },
  input(e) {
    const value = e.detail.value;
    this._text = value;
    this._textVersion = (this._textVersion || 0) + 1;
    const hasText = Boolean(String(value || '').trim());
    if (hasText !== this.data.hasText) this.setData({ hasText });
  },
  removeQuestion() {
    this.setData({ question: null, questionTitle: '' });
  },
  saveConversationCache() {
    if (!this.data.id || !this.data.conversation) return;
    cache.set('chat:conv:' + this.data.id, {
      conversation: this.data.conversation,
      mainTab: this.data.mainTab,
      teacher: this.data.teacher,
      libraryActions: this.data.libraryActions,
      questionActions: this.data.questionActions,
      assets: this.data.assets,
      readOnly: this.data.readOnly,
      messages: this.data.messages,
      hasOlder: this.data.hasOlder,
      progress: this.data.progress,
    });
  },
  async load() {
    const request = (this._conversationRequest || 0) + 1;
    this._conversationRequest = request;
    try {
      const result = await l.request('/api/ai/conversations/' + this.data.id);
      if (request !== this._conversationRequest) return;
      const user = storage.getUser();
      this.setData({
        conversation: result.conversation,
        mainTab: result.conversation.mode === 'library' ? 'library' : 'chat',
        teacher: user.role === 'teacher',
        libraryError: '',
        libraryActions: result.libraryActions || [],
        questionActions: (result.questionActions || []).map(action => ({
          ...action,
          statusLabel: action.status === 'partial_failure'
            ? '成功 ' + action.result.succeeded.length + ' 道，失败 ' + action.result.failed.length + ' 道'
            : ({ applying: '正在执行', confirmed: '已确认并写入题库', rejected: '已取消', failed: '执行失败' })[action.status] || '等待确认 · 确认后将修改题库',
        })),
        assets: result.assets.map((x) => ({
          ...x,
          selected:
            this.data.assets.find((a) => a.resourceId === x.resourceId)
              ?.selected || false,
        })),
        readOnly: String(result.conversation.owner_id) !== String(user.id),
      });
      if (result.conversation.active_run) {
        if (!this.data.running) {
          this._sequence = 0;
          this.clearStreamBuffer();
          this.setData({
            running: true,
            runId: result.conversation.active_run,
            hasPartial: false,
            streamHead: '',
            streamTail: '',
          });
          this.connect();
        }
      }
      await this.mergeMessages(result);
      this.saveConversationCache();
      this._lastLoadedAt = Date.now();
      if (
        (result.libraryActions?.some(x => x.status === 'applying') || result.assets.some((x) =>
          ['queued', 'processing'].includes(x.status),
        )) &&
        this._visible
      )
        this._timer = setTimeout(() => this.load(), 1200);
    } catch (e) {
      if (this.data.mainTab === 'library') this.setData({ libraryError: e.message });
      else l.error(e);
    }
  },
  async confirmLibraryAction(e) {
    if (this.data.confirmingAction || this.data.readOnly) return;
    const id = e.currentTarget.dataset.id;
    this.setData({ confirmingAction: id });
    try {
      await l.request('/api/ai/conversations/' + this.data.id + '/library-actions/' + id + '/confirm', 'POST', {});
      cache.invalidate('drive:');
      cache.invalidate('question:');
      await this.load();
    } catch (e) { l.error(e); await this.load(); }
    finally { this.setData({ confirmingAction: '' }); }
  },
  async confirmQuestionAction(e) {
    if (this.data.confirmingAction || this.data.readOnly) return;
    const id = e.currentTarget.dataset.id;
    this.setData({ confirmingAction: id });
    try {
      const outcome = await l.request('/api/ai/conversations/' + this.data.id + '/question-actions/' + id + '/confirm', 'POST', {});
      cache.invalidate('bank:');
      cache.invalidate('question:');
      cache.invalidate('admin-bank:');
      wx.showToast({ title: outcome.status === 'confirmed' ? '已确认执行' : '部分操作失败', icon: 'none' });
      await this.load();
    } catch (e) { l.error(e); await this.load(); }
    finally { this.setData({ confirmingAction: '' }); }
  },
  async rejectQuestionAction(e) {
    if (this.data.confirmingAction || this.data.readOnly) return;
    const id = e.currentTarget.dataset.id;
    this.setData({ confirmingAction: id });
    try {
      await l.request('/api/ai/conversations/' + this.data.id + '/question-actions/' + id + '/reject', 'POST', {});
      await this.load();
    } catch (e) { l.error(e); }
    finally { this.setData({ confirmingAction: '' }); }
  },
  async send() {
    if (this.data.running || this.data.sending || this.data.uploading || this.data.readOnly) return;
    const text = this._text !== undefined ? this._text : this.data.text;
    if (
      !text.trim() &&
      !this.data.question &&
      !this.data.assets.some((x) => x.selected)
    )
      return;
    const { question } = this.data;
    const textVersion = this._textVersion;
    const assets = this.data.assets.filter(x => x.selected).map(x => x.resourceId);
    const payload = { text, question, assets };
    const payloadKey = JSON.stringify(payload);
    if (this._sendRequest?.payloadKey !== payloadKey)
      this._sendRequest = { payloadKey, requestId: l.id() };
    const { requestId } = this._sendRequest;
    this.setData({ sending: true, error: '' });
    try {
      const result = await l.request(
        '/api/ai/conversations/' + this.data.id + '/messages',
        'POST',
        { requestId, ...payload },
      );
      cache.invalidate('recent:conversations');
      cache.invalidate('history:');
      this._sendRequest = null;
      this._sequence = 0;
      this.clearStreamBuffer();
      if (textVersion === this._textVersion) this._text = '';
      this.setData({
        ...(textVersion === this._textVersion ? { text: '', hasText: false } : {}),
        ...(question === this.data.question ? { question: null, questionTitle: '' } : {}),
        running: true,
        runId: result.runId,
        hasPartial: false,
        streamHead: '',
        streamTail: '',
        pendingText: '',
        progress: '正在准备回答',
        error: '',
        assets: this.data.assets.map(x => assets.includes(x.resourceId) ? { ...x, selected: false } : x),
      });
      this.connect();
      await this.loadMessages();
    } catch (e) {
      this.setData({ error: e.message });
      l.error(e);
    } finally {
      this.setData({ sending: false });
    }
  },
  async older() {
    if (!this.data.messages.length || !this.data.hasOlder || this.data.loadingOlder) return;
    this.setData({ loadingOlder: true });
    try {
      const result = await l.request(
        '/api/ai/conversations/' +
          this.data.id +
          '?beforeSequence=' +
          this.data.messages[0].seq,
      );
      await this.mergeMessages(result);
    } catch (e) {
      l.error(e);
    } finally {
      this.setData({ loadingOlder: false });
    }
  },
  async loadMessages() {
    const result = await l.request('/api/ai/conversations/' + this.data.id);
    await this.mergeMessages(result);
  },
  async mergeMessages(result) {
    const existing = this.data.messages || [];
    const known = new Set(existing.map(message => message.id));
    const incomingRaw = result.messages.filter(message => !known.has(message.id));
    const incoming = incomingRaw.map(renderInstant).sort((a, b) => a.seq - b.seq);
    const latestFromExisting = existing[existing.length - 1];
    const latest = incoming.length
      ? (latestFromExisting && latestFromExisting.seq > incoming[incoming.length - 1].seq ? latestFromExisting : incoming[incoming.length - 1])
      : latestFromExisting;
    const update = {
      ...(this.data.pendingText ? { pendingText: '' } : {}),
      ...(this.data.running || !this.data.hasPartial ? {} : { hasPartial: false, streamHead: '', streamTail: '' }),
    };
    if (!this.data.running && latest && latest.role === 'assistant' && latest.created_at) {
      update.progress = fileUtil.formatDate(latest.created_at);
    }
    if (!incoming.length) {
      if (Object.keys(update).length) this.setData(update);
      return;
    }
    const canAppendOnly = existing.length > 0 && incoming[0].seq > existing[existing.length - 1].seq;
    if (canAppendOnly) {
      const baseLen = existing.length;
      incoming.forEach((msg, i) => {
        update[`messages[${baseLen + i}]`] = msg;
      });
      update.hasOlder = existing[0].seq > 1;
    } else {
      const messages = new Map(existing.map(message => [message.id, message]));
      incoming.forEach(message => messages.set(message.id, message));
      const merged = [...messages.values()].sort((a, b) => a.seq - b.seq);
      update.messages = merged;
      update.hasOlder = merged.length > 0 && merged[0].seq > 1;
    }
    this.setData(update);
    this.saveConversationCache();
  },
  clearStreamBuffer() {
    if (this._streamFlushTimer) {
      clearTimeout(this._streamFlushTimer);
      this._streamFlushTimer = null;
    }
    this._partial = undefined;
    this._pendingDelta = '';
  },
  flushStreamDelta() {
    this._streamFlushTimer = null;
    const delta = this._pendingDelta || '';
    if (!delta) return;
    this._pendingDelta = '';
    const head = this._partial || '';
    this._partial = head + delta;
    this.setData({
      streamHead: head,
      streamTail: delta,
      streamTick: this.data.streamTick + 1,
      hasPartial: true,
    });
  },
  consume(event) {
    if (event.seq <= this._sequence) return;
    this._sequence = event.seq;
    if (event.type === 'text-delta') {
      const tail = event.data.text || '';
      if (!tail) return;
      if (this._partial === undefined) this._partial = '';
      this._pendingDelta = (this._pendingDelta || '') + tail;
      if (!this._streamFlushTimer) {
        this._streamFlushTimer = setTimeout(() => this.flushStreamDelta(), 60);
      }
    }
    else if (event.type === 'tool-started')
      this.setData({
        progress: '正在' + (toolNames[event.data.name] || '处理资料'),
      });
    else if (event.type === 'tool-failed')
      this.setData({ progress: event.data.message });
    else if (
      [
        'run-completed',
        'run-failed',
        'run-cancelled',
        'run-interrupted',
      ].includes(event.type)
    ) {
      const completed = event.type === 'run-completed';
      const fullPartial = (this._partial || '') + (this._pendingDelta || '');
      this.clearStreamBuffer();
      const pendingText = completed && fullPartial
        ? markdown.prepareMarkdown(fullPartial)
        : '';
      this.setData({
        running: false,
        pendingText,
        hasPartial: false,
        streamHead: '',
        streamTail: '',
        progress: completed
          ? fileUtil.formatDate(event.created_at || new Date().toISOString())
          : event.data.message ||
            {
              'run-cancelled': '已取消',
              'run-interrupted': '运行已中断',
              'run-failed': '生成失败',
            }[event.type],
      });
      this._terminal = true;
      this.load();
    }
  },
  connect() {
    if (!this._visible || !this.data.running) return;
    this._terminal = false;
    this._stream = l.subscribe(
      this.data.runId,
      this._sequence || 0,
      (event) => this.consume(event),
      (error) => {
        if (!this._visible || this._terminal) return;
        this._stream = null;
        if (error) this.poll();
        else this._timer = setTimeout(() => this.connect(), 300);
      },
    );
    if (!this._stream) this.poll();
  },
  async poll() {
    if (!this._visible || !this.data.running) return;
    try {
      const result = await l.request(
        '/api/ai/runs/' +
          this.data.runId +
          '/events?afterSequence=' +
          (this._sequence || 0),
      );
      result.events.forEach((e) => this.consume(e));
      if (
        !['queued', 'running'].includes(result.run.status) &&
        !result.events.length
      ) {
        this.setData({
          running: false,
          progress: result.run.error || result.run.status,
        });
        await this.load();
        return;
      }
    } catch (e) {
      this.setData({ error: e.message });
    }
    if (this.data.running) this._timer = setTimeout(() => this.poll(), 700);
  },
  async cancel() {
    try {
      await l.request('/api/ai/runs/' + this.data.runId + '/cancel', 'POST');
      this.setData({ running: false, progress: '已取消' });
      if (this._stream) this._stream.abort();
      await this.load();
    } catch (e) {
      l.error(e);
    }
  },
  async attach() {
    if (this.data.sending || this.data.running || this.data.uploading || this.data.readOnly) return;
    try {
      const files = await l.pickFiles(true);
      if (!files || !files.length) return;
      this.setData({ uploading: true });
      for (const file of files) {
        try {
          const result = await l.upload(
            '/api/ai/conversations/' + this.data.id + '/assets',
            file,
          );
          const detail = await l.request(
            '/api/library/' +
              result.resourceId +
              '?revisionId=' +
              result.revisionId,
          );
          this.setData({
            assets: this.data.assets.concat({
              resourceId: result.resourceId,
              revisionId: result.revisionId,
              status: detail.status,
              data: { title: file.name },
              selected: true,
            }),
          });
        } catch (e) {
          l.error(e);
        }
      }
      await this.refreshAssets();
    } catch (e) {
      if (!String(e.errMsg || '').includes('cancel')) l.error(e);
    } finally {
      this.setData({ uploading: false });
    }
  },
  async refreshAssets() {
    if (!this._visible) return;
    try {
      const result = await l.request('/api/ai/conversations/' + this.data.id);
      this.setData({
        assets: result.assets.map((x) => ({
          ...x,
          selected:
            this.data.assets.find((a) => a.resourceId === x.resourceId)?.selected ||
            false,
        })),
      });
      this.saveConversationCache();
      if (
        this.data.assets.some((x) =>
          ['queued', 'processing'].includes(x.status),
        )
      )
        this._timer = setTimeout(() => this.refreshAssets(), 1200);
    } catch (e) {
      l.error(e);
    }
  },
  asset(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (this.data.readOnly) {
      l.go(
        '/pages/question/detail?id=' +
          this.data.assets[index].resourceId +
          '&revisionId=' +
          this.data.assets[index].revisionId +
          '&document=1',
      );
      return;
    }
    if (this.data.sending) return;
    this.setData({
      ['assets[' + index + '].selected']: !this.data.assets[index].selected,
    });
  },
  openAsset(e) {
    l.go(
      '/pages/question/detail?id=' +
        e.currentTarget.dataset.id +
        '&revisionId=' +
        e.currentTarget.dataset.revision +
        '&document=1',
    );
  },
  citation(e) {
    const ref = e.currentTarget.dataset.ref;
    if (ref.url) {
      wx.setClipboardData({ data: ref.url });
      return;
    }
    l.go(
      '/pages/question/detail?id=' +
        ref.resourceId +
        '&revisionId=' +
        ref.revisionId,
    );
  },
  async applyDraft(e) {
    if (this.data.applyingDraft || this.data.readOnly) return;
    this.setData({ applyingDraft: true });
    try {
      const message = this.data.messages[Number(e.currentTarget.dataset.index)],
        text = message.data.text,
        match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      const draft = JSON.parse(match ? match[1] : text);
      if (!draft.content) throw new Error('生成结果尚未包含完整草稿');
      const confirmed = await l.confirm('应用后将替换教师工作台中的草稿。', {
        title: '应用教学草稿',
        confirmText: '应用',
      });
      if (!confirmed) return;
      const agent = await l.request(
        '/api/ai/agents/' + this.data.conversation.agent_id,
      );
      await l.request('/api/ai/agents/' + agent.id + '/draft', 'PUT', {
        ...draft,
        modelId: agent.draft_model_id,
        parameters: agent.draft_parameters,
        builderConversationId: this.data.id,
      });
      cache.invalidate('agents:');
      cache.invalidate('studio:');
      wx.showToast({ title: '已应用到草稿' });
    } catch (e) {
      l.error(e);
    } finally {
      this.setData({ applyingDraft: false });
    }
  },
});
