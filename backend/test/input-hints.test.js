// 验证聚焦提示不会清除内容，迟到失焦事件不会影响其他字段，并覆盖全部占位提示。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../../miniprogram');
const withInputHints = require(path.join(root, 'utils/input-hints'));
const event = id => ({ currentTarget: { dataset: { hintId: id } } });
function page(definition = {}) {
  const config = withInputHints({ data: { text: '保留输入内容', ...definition.data }, ...definition });
  return { ...config, data: structuredClone(config.data), setData(values) { Object.assign(this.data, values); } };
}
test('focus and blur only update the hint state and preserve typed or saved values', () => {
  const p = page({ data: { text: '保留输入内容', password: 'synthetic-existing-value' } });
  p.onInputHintFocus(event('search')); assert.equal(p.data.inputHintFocus, 'search');
  p.onInputHintBlur(event('search')); assert.equal(p.data.inputHintFocus, '');
  assert.equal(p.data.text, '保留输入内容'); assert.equal(p.data.password, 'synthetic-existing-value');
});
test('a late blur from the previous field cannot restore the active field hint', () => {
  const p = page(); p.onInputHintFocus(event('first')); p.onInputHintFocus(event('second'));
  p.onInputHintBlur(event('first')); assert.equal(p.data.inputHintFocus, 'second');
  p.onInputHintBlur(event('second')); assert.equal(p.data.inputHintFocus, '');
});
test('leaving the page restores hints and preserves the existing draft lifecycle callback', () => {
  let saved;
  const p = page({ onHide(reason) { saved = { text: this.data.text, reason }; return 'original-return'; } });
  p.onInputHintFocus(event('chat'));
  assert.equal(p.onHide('navigation'), 'original-return');
  assert.equal(p.data.inputHintFocus, ''); assert.deepEqual(saved, { text: '保留输入内容', reason: 'navigation' });
});
test('every input and textarea placeholder uses the shared focus behavior', () => {
  const pages = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).pages;
  let total = 0;
  for (const pagePath of pages) {
    const markup = fs.readFileSync(path.join(root, pagePath + '.wxml'), 'utf8');
    const controls = markup.match(/<(?:input|textarea)\b(?:"[^"]*"|'[^']*'|[^'">])*\/?\s*>/g) || [];
    const ids = new Set(); let hints = 0;
    for (const control of controls) {
      if (!/\splaceholder=/.test(control)) continue;
      total++; hints++;
      assert.match(control, /placeholder="\{\{inputHintFocus===/u, pagePath);
      assert.match(control, /\sbindfocus="[^"]+"/u, pagePath); assert.match(control, /\sbindblur="[^"]+"/u, pagePath);
      const id = control.match(/data-hint-id="([^"]+)"/u)?.[1]; assert.ok(id, pagePath); assert.ok(!ids.has(id), pagePath); ids.add(id);
    }
    if (hints) assert.match(fs.readFileSync(path.join(root, pagePath + '.js'), 'utf8'), /Page\(withInputHints\(/u, pagePath);
  }
  assert.ok(total > 20, 'all form families are represented');
});
