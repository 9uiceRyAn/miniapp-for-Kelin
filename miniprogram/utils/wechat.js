const api = require('./api');
const storage = require('./storage');
function request(path, data) {
  return api.request({path:'/api/auth/wechat/'+path,method:'POST',data,auth:false});
}
function finish(page, data) {
  if (page._left) return;
  storage.remove(storage.KEYS.REMEMBER_TOKEN);
  storage.saveSession(data);
  page.setData({ wechatTicket: '' });
  wx.reLaunch({
    url: '/pages/learning/index',
    fail: () => page.setData({ loading: false }),
  });
}
module.exports = {
  async wechatLogin() {
    if (!this.data.wechatEnabled || this.data.loading || this.data.autoLoggingIn) return;
    this.setData({loading:true,errorMessage:''});
    try {
      const login = await new Promise((resolve,reject)=>wx.login({success:resolve,fail:reject}));
      const data=await request('mini',{code:login.code});
      if (this._left) return;
      if(data.needsAccount)this.setData({wechatTicket:data.ticket,wechatAction:'bind',wechatRole:'student',loading:false});
      else finish(this,data);
    }catch(e){this.setData({loading:false,errorMessage:e.message||'微信登录失败'});}
  },
  wechatField(e){this.setData({[e.currentTarget.dataset.field]:e.detail.value});},
  wechatMode(e){this.setData({wechatAction:e.currentTarget.dataset.mode,errorMessage:''});},
  wechatRole(e){this.setData({wechatRole:e.detail.value?'teacher':'student'});},
  async wechatComplete(){
    if (this.data.loading || this.data.autoLoggingIn) return;
    this.setData({loading:true,errorMessage:''});
    try {
      const { wechatTicket: ticket, wechatAction: action } = this.data;
      const fields = action === 'bind'
        ? { username: this.data.username, password: this.data.password }
        : { role: this.data.wechatRole, registerCode: this.data.wechatRegisterCode };
      const data = await request('complete', { ticket, action, ...fields });
      finish(this,data);
    }catch(e){this.setData({loading:false,errorMessage:e.message||'绑定失败'});}
  },
};
