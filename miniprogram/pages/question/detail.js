const workspace = require('../../utils/workspace');
function visibleMedia(images, otherMedia, answers, document) {
  return {
    visibleImages: images.filter(image => document || image.answer === answers),
    visibleOtherMedia: otherMedia.filter(entry => document || ['answer', 'ms', 'sm'].includes(entry.kind) === answers),
  };
}
const OPEN_DOCUMENT_TYPES = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf']);
const MIME_TO_DOC_TYPE = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
function resolveDocFileType(entry, fallbackExt, filePath) {
  const mime = String(entry?.mime || '').split(';')[0].trim().toLowerCase();
  if (MIME_TO_DOC_TYPE[mime]) return MIME_TO_DOC_TYPE[mime];
  for (const raw of [fallbackExt, entry?.extension]) {
    const ext = String(raw || '').replace(/^\./, '').trim().toLowerCase();
    if (OPEN_DOCUMENT_TYPES.has(ext)) return ext;
  }
  for (const raw of [entry?.label, entry?.path, filePath]) {
    const clean = String(raw || '').split('?')[0].split('#')[0].trim().toLowerCase();
    const dot = clean.lastIndexOf('.');
    if (dot >= 0) {
      const ext = clean.slice(dot + 1);
      if (OPEN_DOCUMENT_TYPES.has(ext)) return ext;
    }
  }
  return '';
}
const l = require('../../utils/learning'),
  api = require('../../utils/api'),
  storage = require('../../utils/storage'),
  cache = require('../../utils/cache');

const DETAIL_CACHE_TTL = 60 * 1000;
Page({
  data: {
    mainTab: 'bank',
    id: '',
    revisionId: '',
    document: false,
    item: null,
    images: [],
    visibleImages: [],
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
    return this.load();
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
    if (this.data.item && ['queued', 'processing'].includes(this.data.item.status)) {
      this.load();
    }
  },
  back() {
    wx.navigateBack();
  },
  async load(options = {}) {
    const cacheKey = 'question:detail:' + this.data.id + ':' + (this.data.revisionId || 'latest');
    const cached = !options.force ? cache.get(cacheKey, { maxAge: DETAIL_CACHE_TTL }) : null;
    if (cached) {
      this.setData({ ...cached.value, loading: false, error: '' });
      if (cached.fresh && !['queued', 'processing'].includes(cached.value.item?.status)) {
        return;
      }
    }
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
      const snapshot = {
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
      };
      cache.set(cacheKey, snapshot);
      if (item.revisionId) {
        cache.set('question:detail:' + this.data.id + ':' + item.revisionId, snapshot);
      }
      this.setData({
        ...snapshot,
        loading: false,
        error: '',
      });
      if (['queued', 'processing'].includes(item.status))
        this._poll = setTimeout(() => this.load({ force: true }), 1200);
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
    const urls = this.data.visibleImages
      .filter((image) => image.available && image.url)
      .map((image) => image.url);
    const current = e.currentTarget.dataset.url;
    if (!urls.length || !urls.includes(current)) return;
    wx.previewImage({ current, urls });
  },
  async imageError(e) {
    const id = e.currentTarget.dataset.id;
    this._renewed = this._renewed || {};
    if (this._renewed[id]) return;
    this._renewed[id] = true;
    await this.load({ force: true });
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
    audio.onTimeUpdate(() => {
      const current = Math.floor(audio.currentTime || 0);
      const duration = Math.floor(audio.duration || 0);
      if (current !== this.data.current || duration !== this.data.duration) {
        this.setData({ current, duration });
      }
    });
    audio.onError(async () => {
      if (this._renewing) {
        this.setData({ playing: false });
        wx.showToast({ title: '音频不可用，请重试', icon: 'none' });
        return;
      }
      this._renewing = true;
      const at = this.data.current;
      await this.load({ force: true });
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
      if (!entry) return;
      const file = await api.download({
        path: entry.path,
        fileName: entry.label,
      });
      const fileType = resolveDocFileType(entry, '', file.filePath);
      const options = {
        filePath: file.filePath,
        showMenu: true,
        fail: () =>
          wx.showToast({ title: '此格式暂不支持直接预览', icon: 'none' }),
      };
      if (fileType) options.fileType = fileType;
      wx.openDocument(options);
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
      const fileType = resolveDocFileType(original, this.data.item?.extension, downloaded.filePath);
      if (fileType) {
        wx.openDocument({
          filePath: downloaded.filePath,
          fileType,
          showMenu: true,
          fail: () =>
            wx.showToast({ title: '此格式暂不支持直接预览', icon: 'none' }),
        });
      } else {
        wx.showToast({ title: '资料正文已显示在本页', icon: 'none' });
      }
    } catch (e) {
      l.error(e);
    }
  },
  async ask() {
    if (this.data.loadingTutors) return;
    this.resetExisting();
    const cached = cache.get('agents:tutors', { maxAge: DETAIL_CACHE_TTL });
    if (cached) {
      this.setData({ choosing: true, loadingTutors: false, tutors: cached.value, tutorIndex: 0 });
      if (cached.fresh) return;
    } else {
      this.setData({ choosing: true, loadingTutors: true });
    }
    try {
      const result = await l.request('/api/ai/agents?pageSize=100');
      cache.set('agents:tutors', result.items || []);
      this.setData({ tutors: result.items, tutorIndex: 0 });
    } catch (e) {
      if (!cached) l.error(e);
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
      cache.invalidate('question:detail:' + this.data.id);
      cache.invalidate('bank:');
      cache.invalidate('drive:');
      await this.load({ force: true });
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
      cache.invalidate('question:detail:' + this.data.id);
      cache.invalidate('bank:');
      cache.invalidate('drive:');
      await this.load({ force: true });
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
      cache.invalidate('question:detail:' + this.data.id);
      cache.invalidate('bank:');
      cache.invalidate('drive:');
      wx.navigateBack();
    } catch (e) {
      l.error(e);
    } finally {
      this._withdrawing = false;
    }
  },
});
