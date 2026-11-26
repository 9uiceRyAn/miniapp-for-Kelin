// 验证所有输入控件使用微信原生静态 placeholder、统一 placeholder-class 与统一样式规则。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../../miniprogram');

test('every input and textarea placeholder uses native static behavior and ws-placeholder', () => {
  const pages = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).pages;
  let total = 0;
  for (const pagePath of pages) {
    const markup = fs.readFileSync(path.join(root, pagePath + '.wxml'), 'utf8');
    const script = fs.readFileSync(path.join(root, pagePath + '.js'), 'utf8');
    assert.doesNotMatch(script, /input-hints|withInputHints/, pagePath);
    const controls = markup.match(/<(?:input|textarea)\b(?:"[^"]*"|'[^']*'|[^'">])*\/?\s*>/g) || [];
    for (const control of controls) {
      assert.doesNotMatch(control, /inputHintFocus|onInputHintFocus|onInputHintBlur|data-hint-id/, pagePath);
      if (!/\splaceholder=/.test(control)) continue;
      total++;
      assert.match(control, /\splaceholder-class="ws-placeholder"/, pagePath);
    }
  }
  assert.ok(total > 20, 'all form families are represented');
});

test('global placeholder class and unified single-line input styles are configured', () => {
  const appWxss = fs.readFileSync(path.join(root, 'app.wxss'), 'utf8');
  assert.match(appWxss, /\.ws-placeholder\s*\{[^}]*color:/);
  const compWxss = fs.readFileSync(path.join(root, 'styles/workspace-components.wxss'), 'utf8');
  assert.match(compWxss, /\.ws-input\s*\{[^}]*line-height:\s*42px;[^}]*padding:\s*0 12px;/s);
  const learningWxss = fs.readFileSync(path.join(root, 'styles/learning.wxss'), 'utf8');
  assert.doesNotMatch(learningWxss, /(^|[},])\s*(input|textarea)\s*[,{]/);
});
