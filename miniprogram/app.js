// miniprogram/app.js

const storage = require('./utils/storage');

App({
  globalData: {
    user: null,
  },

  onLaunch() {
    this.globalData.user = storage.getUser();

    console.log('小程序初始化完成');
  },
});