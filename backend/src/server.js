require('dotenv').config();

const express = require('express');

const {
  testConnection,
} = require('./db');

const authRoutes =
  require('./routes/auth');
const fileRoutes =
  require('./routes/files');
const markRoutes =
  require('./routes/marks');

const app = express();

const PORT =
  Number(process.env.PORT || 3000);

app.use(express.json({
  limit: '2mb',
}));

app.use(express.urlencoded({
  extended: true,
}));


app.get('/api/health', async (req, res) => {
  try {
    await testConnection();

    return res.json({
      success: true,
      data: {
        status: 'ok',
        database: 'connected',
        timestamp:
          new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error(
      'health check error:',
      error,
    );

    return res.status(500).json({
      success: false,
      message:
        '数据库连接失败',
    });
  }
});


app.use('/api/auth', authRoutes);

app.use('/api/files', fileRoutes);

app.use('/api/marks', markRoutes);

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: '接口不存在',
  });
});


app.use((error, req, res, next) => {
  console.error(
    'Unhandled error:',
    error,
  );

  return res.status(500).json({
    success: false,
    message: '服务器内部错误',
  });
});


app.listen(
  PORT,
  '127.0.0.1',
  () => {
    console.log(
      `File Manager API running at http://127.0.0.1:${PORT}`,
    );
  },
);
