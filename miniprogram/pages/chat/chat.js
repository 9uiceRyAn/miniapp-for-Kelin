const l = require('../../utils/learning');
const workspace = require('../../utils/workspace');
const toolNames = {
  propose_library_change: '准备资料操作',
  search_existing_files: '查找已有 A–E 资料',
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
    pageInsets: '',
    conversation: null,
    teacher: false,
    libraryActions: [],
    confirmingAction: '',
    messages: [],
    assets: [],
    text: '',
    question: null,
    questionTitle: '',
    running: false,
    runId: '',
    partial: '',
    progress: '',
    uploading: false,
    readOnly: false,
    error: '',
    applying: false,
    hasOlder: false,
  },
  async onLoad(options) {
    if (!l.guard()) return;
    this.setData({ id: options.id, pageInsets: workspace.pageInsetsStyle(wx) });
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
    await this.load();
    if (!this.data.readOnly && wx.getStorageSync) {
      const draft = wx.getStorageSync(this.draftKey());
      if (draft) this.setData({ text: draft.text || '', question: draft.question || null, questionTitle: draft.questionTitle || '', assets: this.data.assets.map(asset => ({ ...asset, selected: (draft.selectedAssets || []).includes(asset.resourceId) })) });
    }
    await this.loadRecent();
    if (options.initialText && !this.data.readOnly) {
      this.setData({ text: options.initialText });
      await this.send();
    }
  },
  onResize() {
    this.setData({ pageInsets: workspace.pageInsetsStyle(wx) });
  },
  onShow() {
    this._visible = true;
    if (this.data.conversation) {
      this.setData({ running: false, partial: '' });
      this.load();
    }
  },
  onHide() {
    if (this.data.id && !this.data.readOnly && wx.setStorageSync) {
      wx.setStorageSync(this.draftKey(), { text: this.data.text, question: this.data.question, questionTitle: this.data.questionTitle, selectedAssets: this.data.assets.filter(asset => asset.selected).map(asset => asset.resourceId) });
    }
    this._visible = false;
    clearTimeout(this._timer);
    if (this._stream) this._stream.abort();
  },
  onUnload() {
    this.onHide();
  },
  back() {
    wx.navigateBack();
  },
  toggleDrawer() { this.setData({ drawerOpen: !this.data.drawerOpen }); },
  closeDrawer() { this.setData({ drawerOpen: false }); },
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
  draftKey() { return 'learning-chat-draft:' + require('../../utils/storage').getUser().id + ':' + this.data.id; },
  home() { wx.reLaunch({ url: '/pages/home/home' }); },
  async selectMain(e) {
    const id = e.currentTarget.dataset.id;
    if (id === 'chat') { this.closeDrawer(); return; }
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    const index = pages.map(page => page.route).lastIndexOf('pages/learning/index');
    if (index >= 0 && index < pages.length - 1) {
      await pages[index].selectMain(e);
      wx.navigateBack({ delta: pages.length - 1 - index });
    } else wx.redirectTo({ url: '/pages/learning/index?section=' + id });
  },
  async selectSection(e) {
    if (e.currentTarget.dataset.id === 'library' && this.data.teacher) {
      try {
        const conversation = await l.request('/api/ai/library-manager/conversation', 'POST', {});
        if (conversation.id === this.data.id) { this.closeDrawer(); return; }
        wx.redirectTo({ url: '/pages/chat/chat?id=' + encodeURIComponent(conversation.id) });
      } catch (e) { l.error(e); }
      return;
    }
    wx.redirectTo({ url: '/pages/learning/index?section=' + e.currentTarget.dataset.id });
  },
  conversation(e) {
    if (e.currentTarget.dataset.id === this.data.id) { this.closeDrawer(); return; }
    wx.redirectTo({ url: '/pages/chat/chat?id=' + e.currentTarget.dataset.id });
  },
  input(e) {
    this.setData({ text: e.detail.value });
    this._requestId = null;
  },
  removeQuestion() {
    this.setData({ question: null, questionTitle: '' });
  },
  async load() {
    try {
      const result = await l.request('/api/ai/conversations/' + this.data.id);
      const user = require('../../utils/storage').getUser();
      this.setData({
        conversation: result.conversation,
        teacher: user.role === 'teacher',
        libraryActions: result.libraryActions || [],
        messages: result.messages,
        hasOlder: result.hasOlder,
        assets: result.assets.map((x) => ({
          ...x,
          selected:
            this.data.assets.find((a) => a.resourceId === x.resourceId)
              ?.selected || false,
        })),
        readOnly: String(result.conversation.owner_id) !== String(user.id),
      });
      for (let i = 0; i < result.messages.length; i++) {
        try {
          const message = await l.renderMessage(result.messages[i]);
          this.setData({ ['messages[' + i + ']']: message });
        } catch (e) {
          /* Plain text stays readable when formula rendering is unavailable. */
        }
      }
      if (result.conversation.active_run) {
        if (!this.data.running) {
          this._sequence = 0;
          this.setData({
            running: true,
            runId: result.conversation.active_run,
            partial: '',
          });
          this.connect();
        }
      } else this.setData({ running: false, progress: '' });
      if (
        (result.libraryActions?.some(x => x.status === 'applying') || result.assets.some((x) =>
          ['queued', 'processing'].includes(x.status),
        )) &&
        this._visible
      )
        this._timer = setTimeout(() => this.load(), 1200);
    } catch (e) {
      l.error(e);
    }
  },
  async confirmLibraryAction(e) {
    if (this.data.confirmingAction || this.data.readOnly) return;
    const id = e.currentTarget.dataset.id;
    this.setData({ confirmingAction: id });
    try {
      await l.request('/api/ai/conversations/' + this.data.id + '/library-actions/' + id + '/confirm', 'POST', {});
      await this.load();
    } catch (e) { l.error(e); await this.load(); }
    finally { this.setData({ confirmingAction: '' }); }
  },
  async send() {
    if (this.data.running || this.data.uploading || this.data.readOnly) return;
    if (
      !this.data.text.trim() &&
      !this.data.question &&
      !this.data.assets.some((x) => x.selected)
    )
      return;
    this._requestId = this._requestId || l.id();
    try {
      const result = await l.request(
        '/api/ai/conversations/' + this.data.id + '/messages',
        'POST',
        {
          requestId: this._requestId,
          text: this.data.text,
          question: this.data.question,
          assets: this.data.assets
            .filter((x) => x.selected)
            .map((x) => x.resourceId),
        },
      );
      this._requestId = null;
      this._sequence = 0;
      this.setData({
        text: '',
        question: null,
        questionTitle: '',
        running: true,
        runId: result.runId,
        partial: '',
        progress: '正在准备回答',
        error: '',
        assets: this.data.assets.map((x) => ({ ...x, selected: false })),
      });
      await this.loadMessages();
      this.connect();
    } catch (e) {
      this.setData({ error: e.message });
      l.error(e);
    }
  },
  async older() {
    if (!this.data.messages.length) return;
    try {
      const result = await l.request(
        '/api/ai/conversations/' +
          this.data.id +
          '?beforeSequence=' +
          this.data.messages[0].seq,
      );
      const messages = [];
      for (const message of result.messages) {
        try {
          messages.push(await l.renderMessage(message));
        } catch {
          messages.push(message);
        }
      }
      this.setData({
        messages: messages.concat(this.data.messages),
        hasOlder: result.hasOlder,
      });
    } catch (e) {
      l.error(e);
    }
  },
  async loadMessages() {
    const result = await l.request('/api/ai/conversations/' + this.data.id);
    this.setData({ messages: result.messages });
  },
  consume(event) {
    if (event.seq <= this._sequence) return;
    this._sequence = event.seq;
    if (event.type === 'text-delta')
      this.setData({ partial: this.data.partial + (event.data.text || '') });
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
      this.setData({
        running: false,
        progress:
          event.data.message ||
          {
            'run-completed': '回答完成',
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
    try {
      const file = await l.pickFile(true);
      this.setData({ uploading: true });
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
      await this.refreshAssets();
    } catch (e) {
      if (!String(e.errMsg || '').includes('cancel')) l.error(e);
    } finally {
      this.setData({ uploading: false });
    }
  },
  async refreshAssets() {
    if (!this._visible) return;
    const current = this.data.assets;
    try {
      const result = await l.request('/api/ai/conversations/' + this.data.id);
      this.setData({
        assets: result.assets.map((x) => ({
          ...x,
          selected:
            current.find((a) => a.resourceId === x.resourceId)?.selected ||
            false,
        })),
      });
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
    try {
      const message = this.data.messages[Number(e.currentTarget.dataset.index)],
        text = message.data.text,
        match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      const draft = JSON.parse(match ? match[1] : text);
      if (!draft.content) throw new Error('生成结果尚未包含完整草稿');
      const agent = await l.request(
        '/api/ai/agents/' + this.data.conversation.agent_id,
      );
      await l.request('/api/ai/agents/' + agent.id + '/draft', 'PUT', {
        ...draft,
        modelId: agent.draft_model_id,
        parameters: agent.draft_parameters,
        builderConversationId: this.data.id,
      });
      wx.showToast({ title: '已应用到草稿' });
    } catch (e) {
      l.error(e);
    }
  },
});
