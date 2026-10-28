// Development overrides are read only in a developer build; release keeps the production origin.
let developmentURL = '';
try {
  if (wx.getAccountInfoSync().miniProgram.envVersion === 'develop') {
    developmentURL = String(wx.getStorageSync('kelinDevBaseURL') || '').replace(/\/$/, '');
  }
} catch (error) { /* CI and older clients use the configured production origin. */ }
const API_BASE_URL = developmentURL || 'https://api.kelinliuxue.com';
module.exports = { API_BASE_URL };
