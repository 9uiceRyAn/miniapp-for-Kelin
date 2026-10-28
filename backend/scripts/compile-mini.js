const path = require('node:path'),
  crypto = require('node:crypto'),
  fs = require('node:fs');
(async () => {
  const ciPath =
    process.env.MINIPROGRAM_CI_PATH ||
    path.resolve(__dirname, '../.local/wechat/node_modules/miniprogram-ci');
  if (!fs.existsSync(ciPath))
    throw new Error(
      'Install miniprogram-ci@2.1.31 into backend/.local/wechat, or set MINIPROGRAM_CI_PATH.',
    );
  const ci = require(ciPath);
  // The SDK constructor requires a key. An ephemeral local key is never used to upload.
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const project = new ci.Project({
    type: 'miniProgram',
    targetPlatform: 'mini-weixin',
    projectPath: path.resolve(__dirname, '../..'),
    privateKey,
    ignores: ['backend/**/*', '.git/**/*', 'docs/**/*', 'deploy/**/*'],
  });
  const output = await ci.getCompiledResult(
    {
      project,
      setting: { es6: true, minify: true },
      threads: 1,
      onProgressUpdate: () => {},
    },
    path.resolve(__dirname, '../.local/wechat-compiled.zip'),
  );
  console.log(
    JSON.stringify({ status: 'compiled', files: Object.keys(output).length }),
  );
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
