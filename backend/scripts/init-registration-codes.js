require('dotenv').config();
const { pool } = require('../src/db');
const { ensureCodes } = require('../src/registration-codes');
ensureCodes().then(() => console.log('注册码已初始化，请通过教师后台查看。'))
  .catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => pool.end());
