const l = require('../../utils/learning'),
  api = require('../../utils/api'),
  storage = require('../../utils/storage');
Page({
  data: {
    mainTab: 'bank',
    id: '',
    revisionId: '',
    document: false,
    item: null,
    images: [],
    otherMedia: [],
    audio: [],
    original: null,
    answers: false,
    loading: true,
    error: '',
    canManage: false,
    canRetry: false,
    tutors: [],
    tutorIndex: 0,
    choosing: false,
    existing: [],
    audioIndex: -1,
    playing: false,
    duration: 0,
    current: 0,
  },
  onLoad(options) {
    if (!l.guard()) return;
    this.setData({
      id: options.id,
      revisionId: options.revisionId || '',
      document: options.document === '1',
    });
    this.load();
  },
  onHide() {
    if (this._audio) this._audio.pause();
    clearTimeout(this._poll);
  },
  onUnload() {
    clearTimeout(this._poll);
    if (this._audio) this._audio.destroy();
  },
  onShow() {
    if (this.data.item) this.load();
  },
  back() {
    wx.navigateBack();
  },
  async load() {
    try {
      const path =
        '/api/question-bank/items/' +
        this.data.id +
        (this.data.revisionId ? '/revisions/' + this.data.revisionId : '');
      const item = await l.request(path);
      const source = item.source_ref || {};
      item.sourceText =
        (source.document || source.file || source.id || '未提供来源名称') +
        (source.pages?.length
          ? ' · 第 ' + source.pages.join('、') + ' 页'
          : '');
      item.hasAnswer = item.media.some((m) =>
        ['answer', 'ms', 'sm'].includes(m.kind),
      );
      const images = item.media
        .filter((m) => m.mime.startsWith('image/'))
        .map((m) => ({
          ...m,
          url: l.url(m.path),
          answer: ['answer', 'ms', 'sm'].includes(m.kind),
        }));
      const audio = item.media
        .filter((m) => m.kind === 'audio')
        .map((m) => ({ ...m, url: l.url(m.path) }));
      this.setData({
        item,
        revisionId: item.revisionId,
        images,
        audio,
        otherMedia: item.media.filter(
          (m) =>
            !m.mime.startsWith('image/') &&
            m.kind !== 'audio' &&
            m.kind !== 'original',
        ),
        original: item.media.find((m) => m.kind === 'original') || null,
        canRetry: String(item.ownerId) === String(storage.getUser()?.id),
        canManage:
          item.visibility === 'public' &&
          String(item.ownerId) === String(storage.getUser()?.id) &&
          storage.getUser()?.role === 'teacher',
        loading: false,
        error: '',
      });
      if (['queued', 'processing'].includes(item.status))
        this._poll = setTimeout(() => this.load(), 1200);
    } catch (e) {
      this.setData({ error: e.message, loading: false });
      l.error(e);
    }
  },
  toggleAnswers() {
    this.setData({ answers: !this.data.answers });
  },
  preview(e) {
    const current = e.currentTarget.dataset.url;
    wx.previewImage({
      current,
      urls: this.data.images
        .filter((x) => x.available && (this.data.answers || !x.answer))
        .map((x) => x.url),
    });
  },
  async imageError(e) {
    const id = e.currentTarget.dataset.id;
    this._renewed = this._renewed || {};
    if (this._renewed[id]) return;
    this._renewed[id] = true;
    await this.load();
  },
  async play(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (this._audio && this.data.audioIndex === index) {
      if (this.data.playing) this._audio.pause();
      else this._audio.play();
      return;
    }
    if (this._audio) this._audio.destroy();
    const audio = wx.createInnerAudioContext();
    this._audio = audio;
    this.setData({ audioIndex: index, current: 0, duration: 0 });
    audio.src = this.data.audio[index].url;
    audio.onPlay(() => this.setData({ playing: true }));
    audio.onPause(() => this.setData({ playing: false }));
    audio.onEnded(() => this.setData({ playing: false }));
    audio.onTimeUpdate(() =>
      this.setData({
        current: Math.floor(audio.currentTime || 0),
        duration: Math.floor(audio.duration || 0),
      }),
    );
    audio.onError(async () => {
      if (this._renewing) {
        this.setData({ playing: false });
        wx.showToast({ title: '音频不可用，请重试', icon: 'none' });
        return;
      }
      this._renewing = true;
      const at = this.data.current;
      await this.load();
      audio.src = this.data.audio[index].url;
      audio.play();
      audio.onCanplay(() => {
        if (at) audio.seek(at);
      });
      setTimeout(() => {
        this._renewing = false;
      }, 2000);
    });
    audio.play();
  },
  seek(e) {
    if (this._audio) this._audio.seek(Number(e.detail.value));
  },
  async openOther(e) {
    try {
      const entry = this.data.otherMedia[Number(e.currentTarget.dataset.index)];
      const file = await api.download({
        path: entry.path,
        fileName: entry.label,
      });
      wx.openDocument({
        filePath: file.filePath,
        showMenu: true,
        fail: () =>
          wx.showToast({ title: '此格式暂不支持直接预览', icon: 'none' }),
      });
    } catch (e) {
      l.error(e);
    }
  },
  async openOriginal() {
    try {
      const original = this.data.original;
      if (!original?.available) return;
      const downloaded = await api.download({
        path: original.path,
        fileName: this.data.item.title,
      });
      const extension = this.data.item.extension.replace('.', '');
      if (['pdf', 'docx'].includes(extension))
        wx.openDocument({
          filePath: downloaded.filePath,
          fileType: extension,
          showMenu: true,
        });
      else wx.showToast({ title: '资料正文已显示在本页', icon: 'none' });
    } catch (e) {
      l.error(e);
    }
  },
  async ask() {
    try {
      const result = await l.request('/api/ai/agents?pageSize=100');
      this.setData({ tutors: result.items, choosing: true });
    } catch (e) {
      l.error(e);
    }
  },
  async selectMain(e) {
    const id = e.currentTarget.dataset.id;
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    const index = pages.map(page => page.route).lastIndexOf('pages/learning/index');
    if (index >= 0 && index < pages.length - 1) {
      await pages[index].selectMain(e);
      wx.navigateBack({ delta: pages.length - 1 - index });
    } else wx.redirectTo({ url: '/pages/learning/index?section=' + (id === 'chat' ? 'agents' : id) });
  },
  tutor(e) {
    this.setData({ tutorIndex: Number(e.detail.value), existing: [] });
  },
  async newConversation() {
    try {
      const tutor = this.data.tutors[this.data.tutorIndex];
      if (!tutor) return;
      const conv = await l.request('/api/ai/conversations', 'POST', {
        agentId: tutor.id,
      });
      this.enter(conv.id);
    } catch (e) {
      l.error(e);
    }
  },
  async chooseExisting() {
    try {
      const tutor = this.data.tutors[this.data.tutorIndex];
      const history = await l.request('/api/ai/conversations');
      this.setData({
        existing: history.filter(
          (x) => x.agent_id === tutor?.id && x.mode === 'student',
        ),
      });
    } catch (e) {
      l.error(e);
    }
  },
  existing(e) {
    this.enter(e.currentTarget.dataset.id);
  },
  enter(id) {
    l.go(
      '/pages/chat/chat?id=' +
        id +
        '&questionId=' +
        this.data.id +
        '&revisionId=' +
        this.data.revisionId,
    );
  },
  async retry() {
    try {
      await l.request('/api/library/' + this.data.id + '/retry', 'POST', {
        revisionId: this.data.revisionId,
      });
      await this.load();
    } catch (e) {
      l.error(e);
    }
  },
  async replace() {
    try {
      const file = await l.pickFile();
      const result = await l.upload(
        '/api/library/' + this.data.id + '/revisions',
        file,
      );
      this.setData({ revisionId: result.revisionId });
      await this.load();
    } catch (e) {
      if (!String(e.errMsg || '').includes('cancel')) l.error(e);
    }
  },
  async withdraw() {
    try {
      await l.request('/api/library/' + this.data.id, 'DELETE');
      wx.navigateBack();
    } catch (e) {
      l.error(e);
    }
  },
});
