const fs = require('node:fs'),
  path = require('node:path'),
  { spawnSync } = require('node:child_process');
function check(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(directory, item.name);
    if (item.isDirectory()) check(name);
    else if (name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', name], {
        stdio: 'inherit',
      });
      if (result.status) process.exit(result.status);
    }
  }
}
check(path.join(__dirname, '../src'));
check(path.join(__dirname, '../../miniprogram'));
