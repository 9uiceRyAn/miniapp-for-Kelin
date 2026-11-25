const workspace = require('../../utils/workspace');
function visibleMedia(images, otherMedia, answers, document) {
  return {
    visibleImages: images.filter(image => document || image.answer === answers),
    visibleOtherMedia: otherMedia.filter(entry => document || ['answer', 'ms', 'sm'].includes(entry.kind) === answers),
  };
}
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
    visibleImages: [],
    previewImages: [],
    previewIndex: 0,
    previewOpen: false,
    visibleOtherMedia: [],
    questionHeading: '',
    paperSummary: '',
    topicLabel: '',
    detailsOpen: false,
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
    loadingTutors: false,
    startingConversation: false,
    existingLoaded: false,
    existing: [],
    existingPage: 0,
    existingHasMore: false,
    existingLoading: false,
    audioIndex: -1,
    playing: false,
    duration: 0,
    current: 0,
  },
  onResize() { this.setData({ navigationStyle: workspace.navigationStyle(wx) }); },
  onLoad(options) {
    this.setData({ navigationStyle: workspace.navigationStyle(wx) });
    if (!l.guard()) return;
    this.setData({
      id: options.id,
      revisionId: options.revisionId || '',
      document: options.document === '1',
      mainTab: options.document === '1' ? 'library' : 'bank',
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
      const source = item.source_ref || {}, details = item.details || {};
      const sourcePages = source.pages || source.question_pages || details.question_pages;
      item.sourceText =
        (source.document || source.question_document || source.file || details.question_document || source.id || '来源未标注') +
        (Array.isArray(sourcePages) && sourcePages.length ? ' · 第 ' + sourcePages.join('、') + ' 页' : '');
      const range = item.question_range || {};
      const first = range.start || details.question_number;
      const last = range.end || first;
      const questionHeading = this.data.document || !first ? item.title : '第 ' + first + (last !== first ? '–' + last : '') + ' 题';
      const paperParts = [details.syllabus_code, details.year ? String(details.year) + (details.session ? ' ' + details.session : '') : '', details.paper ? 'Paper ' + details.paper : ''].filter(Boolean);
      const paperSummary = this.data.document ? (item.extension || '').replace('.', '').toUpperCase() : paperParts.length ? paperParts.join(' · ') : String(item.title || '').replace(/\s*·?\s*(?:Questions?\s*\d+.*|第\s*\d+.*题)$/i, '').trim();
      item.hasAnswer = Boolean(item.answer_text) || item.media.some((m) =>
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
      const user = storage.getUser();
      const answers = !this.data.document && item.hasAnswer && this.data.answers;
      const otherMedia = item.media.filter((m) => !m.mime.startsWith('image/') && m.kind !== 'audio' && m.kind !== 'original').map((m, originalIndex) => ({ ...m, originalIndex }));
      this.setData({
        item,
        questionHeading,
        paperSummary,
        topicLabel: item.primary_tag_name || item.subtitle || '',
        answers,
        ...visibleMedia(images, otherMedia, answers, this.data.document),
        revisionId: item.revisionId,
        images,
        audio,
        otherMedia,
        original: item.media.find((m) => m.kind === 'original') || null,
        canRetry: String(item.ownerId) === String(user?.id),
        canManage:
          item.visibility === 'public' &&
          String(item.ownerId) === String(user?.id) &&
          user?.role === 'teacher',
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
    if (!this.data.item?.hasAnswer) return;
    const answers = !this.data.answers;
    this.setData({
      answers,
      ...visibleMedia(this.data.images, this.data.otherMedia, answers, false),
    });
  },
  toggleDetails() { this.setData({ detailsOpen: !this.data.detailsOpen }); },
  closeTutor() { this.resetExisting(); this.setData({ choosing: false }); },
  preview(e) {
    const previewImages = this.data.visibleImages.filter((image) => image.available);
    const previewIndex = previewImages.findIndex((image) => image.url === e.currentTarget.dataset.url);
    if (previewIndex < 0) return;
    this.setData({ previewImages, previewIndex, previewOpen: true });
  },
  closePreview() { this.setData({ previewOpen: false, previewImages: [] }); },
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
    if (this.data.loadingTutors) return;
    this.resetExisting();
    this.setData({ choosing: true, loadingTutors: true });
    try {
      const result = await l.request('/api/ai/agents?pageSize=100');
      this.setData({ tutors: result.items, tutorIndex: 0 });
    } catch (e) {
      l.error(e);
    } finally { this.setData({ loadingTutors: false }); }
  },
  async selectMain(e) {
    return workspace.returnToWorkspace(e, getCurrentPages(), wx);
  },
  tutor(e) {
    this.resetExisting();
    this.setData({ tutorIndex: Number(e.detail.value) });
  },
  resetExisting() {
    this._existingRequest = (this._existingRequest || 0) + 1;
    this.setData({ existing: [], existingPage: 0, existingHasMore: false, existingLoading: false, existingLoaded: false });
  },
  async newConversation() {
    if (this.data.startingConversation) return;
    this.setData({ startingConversation: true });
    try {
      const tutor = this.data.tutors[this.data.tutorIndex];
      if (!tutor) return;
      const conv = await l.request('/api/ai/conversations', 'POST', {
        agentId: tutor.id,
      });
      this.enter(conv.id);
    } catch (e) {
      l.error(e);
    } finally { this.setData({ startingConversation: false }); }
  },
  async chooseExisting() {
    if (this.data.existingLoading || (this.data.existingLoaded && !this.data.existingHasMore)) return;
    const tutor = this.data.tutors[this.data.tutorIndex];
    if (!tutor) return;
    const request = (this._existingRequest || 0) + 1;
    this._existingRequest = request;
    const page = this.data.existingPage + 1;
    const pageSize = 20;
    this.setData({ existingLoading: true });
    try {
      const history = await l.request('/api/ai/conversations?' + l.query({ agentId: tutor.id, page, pageSize }));
      if (request !== this._existingRequest) return;
      const seen = new Set(this.data.existing.map(row => row.id));
      this.setData({
        existingLoaded: true,
        existingPage: page,
        existingHasMore: history.length === pageSize,
        existing: this.data.existing.concat(history.filter(row => !seen.has(row.id))),
      });
    } catch (e) {
      if (request === this._existingRequest) l.error(e);
    } finally {
      if (request === this._existingRequest) this.setData({ existingLoading: false });
    }
  },
  existing(e) {
    this.enter(e.currentTarget.dataset.id);
  },
  enter(id) {
    this.closeTutor();
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
    if (this._withdrawing) return;
    this._withdrawing = true;
    try {
      const confirmed = await new Promise((resolve, reject) => {
        wx.showModal({
          title: '撤下公共资料',
          content: '撤下后，教学助手将无法检索这份公共资料。',
          confirmText: '撤下',
          success: result => resolve(result.confirm),
          fail: reject,
        });
      });
      if (!confirmed) return;
      await l.request('/api/library/' + this.data.id, 'DELETE');
      wx.navigateBack();
    } catch (e) {
      l.error(e);
    } finally {
      this._withdrawing = false;
    }
  },
});
