const cache = require('./cache');

// Group recent conversations by agent identity while retaining disclosure state.
function groupConversations(rows, previous, activeAgentId) {
  const expanded = new Map((previous || []).map(group => [group.id, group.expanded]));
  const groups = new Map();
  for (const row of rows) {
    const id = row.agent_id || 'unknown';
    if (!groups.has(id)) groups.set(id, {
      id,
      label: row.agent_name || row.name || '教学助手',
      expanded: expanded.has(id) ? expanded.get(id) : activeAgentId ? id === activeAgentId : groups.size === 0,
      items: [],
    });
    const mode = { student: '学习对话', test: '试聊', builder: '创建助手', library: '资料管理' }[row.mode] || '对话';
    const date = String(row.updated_at || '').replace('T', ' ').slice(5, 16);
    groups.get(id).items.push({ ...row, displayTitle: row.title || (mode + (date ? ' · ' + date : '')) });
  }
  return Array.from(groups.values());
}
const drawer = {
  toggleDrawer() { this.setData({ drawerOpen: !this.data.drawerOpen }); },
  closeDrawer() { this.setData({ drawerOpen: false }); },
};
function recentMethods(l, activeAgent = () => null) {
  return {
    async loadRecent(append = false, options = {}) {
      if (append && (this.data.recentLoading || !this.data.recentHasMore)) return;
      const RECENT_CACHE_KEY = 'recent:conversations';
      const RECENT_MAX_AGE = 20000;
      let cached = null;
      if (!append && !options.force) {
        cached = cache.get(RECENT_CACHE_KEY, { maxAge: RECENT_MAX_AGE });
        if (cached) {
          if (!this.data.recentConversations.length) {
            this.setData({
              recentConversations: cached.value,
              recentPage: 1,
              recentHasMore: cached.value.length === 20,
              conversationGroups: groupConversations(cached.value, this.data.conversationGroups, activeAgent(this)),
            });
          }
          if (cached.fresh) return;
        }
      }
      const requestId = (this._recentRequestId || 0) + 1;
      this._recentRequestId = requestId;
      const page = append ? this.data.recentPage + 1 : 1;
      if (!cached) this.setData({ recentLoading: true });
      try {
        const rows = await l.request('/api/ai/conversations?' + l.query({ page }));
        if (requestId !== this._recentRequestId) return;
        if (!append) cache.set(RECENT_CACHE_KEY, rows, { persist: true });
        const unique = new Map((append ? this.data.recentConversations : []).concat(rows).map(row => [row.id, row]));
        const recentConversations = Array.from(unique.values());
        this.setData({ recentConversations, recentPage: page, recentHasMore: rows.length === 20,
          conversationGroups: groupConversations(recentConversations, this.data.conversationGroups, activeAgent(this)) });
      } catch (e) { if (requestId === this._recentRequestId) l.error(e); }
      finally { if (requestId === this._recentRequestId) this.setData({ recentLoading: false }); }
    },
    moreRecent() { return this.loadRecent(true); },
    toggleAgentGroup(e) {
      const id = e.currentTarget.dataset.id;
      this.setData({ conversationGroups: this.data.conversationGroups.map(group => group.id === id ? { ...group, expanded: !group.expanded } : group) });
    },
  };
}
async function returnToWorkspace(e, pages, wx) {
  const id = e.currentTarget.dataset.id;
  const index = pages.map(page => page.route).lastIndexOf('pages/learning/index');
  if (id === 'library') {
    wx.redirectTo({ url: '/pages/learning/index?section=library' });
    return;
  }
  if (index >= 0 && index < pages.length - 1) {
    await pages[index].selectMain(e);
    wx.navigateBack({ delta: pages.length - 1 - index });
  } else wx.redirectTo({ url: '/pages/learning/index?section=' + (id === 'chat' ? 'agents' : id) });
}
function navigationStyle(api) {
  let info = {}, capsule;
  try { info = api.getWindowInfo ? api.getWindowInfo() : api.getSystemInfoSync(); } catch {}
  try { capsule = api.getMenuButtonBoundingClientRect(); } catch {}
  const status = Math.max(Number(info.statusBarHeight) || 0, Number(info.safeArea?.top) || 0);
  const valid = capsule && capsule.top >= status && capsule.height > 0 && capsule.left > 0 && capsule.left < info.windowWidth;
  const top = status > 0 ? status + 'px' : 'env(safe-area-inset-top, 0px)';
  const height = valid ? Math.max(44, 2 * (capsule.top - status) + capsule.height) : 48;
  const right = valid ? info.windowWidth - capsule.left + 8 : 16;
  return '--ws-safe-top:' + top + ';--nav-height:' + height + 'px;--nav-right:' + right + 'px';
}
const profileNav = {
  selectMain(e) {
    const id = e.currentTarget.dataset.id;
    const section = id === 'chat' ? 'agents' : id;
    this.setData({ drawerOpen: false });
    wx.redirectTo({ url: '/pages/learning/index?section=' + section });
  },
  selectSection(e) {
    this.setData({ drawerOpen: false });
    wx.redirectTo({ url: '/pages/learning/index?section=' + e.currentTarget.dataset.id });
  },
  openAgentPresets() {
    this.setData({ drawerOpen: false });
    if (this.data.section !== 'agents-manage') wx.redirectTo({ url: '/pages/studio/studio' });
  },
  openTeacherManagement() {
    this.setData({ drawerOpen: false });
    if (this.data.section !== 'accounts') wx.redirectTo({ url: '/pages/accounts/accounts' });
  },
  home() {
    this.setData({ drawerOpen: false });
    if (this.data.section !== 'question-management') wx.redirectTo({ url: '/pages/home/home' });
  },
  openAdmin() {
    this.setData({ drawerOpen: false });
    if (this.data.section !== 'admin') wx.redirectTo({ url: '/pages/admin/admin' });
  },
};
module.exports = { navigationStyle, drawer, profileNav, recentMethods, returnToWorkspace };
