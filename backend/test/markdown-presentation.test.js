const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepareMarkdown } = require(path.join(__dirname, '../../miniprogram/utils/markdown.js'));

test('prepareMarkdown strips citations and normalizes LaTeX delimiters while protecting code blocks', () => {
  const input = [
    '引用测试[[cite:引用键]][[cite:1234abcd-5678-90ef-1234-567890abcdef]]。',
    '',
    '行内公式 \\(a^2 + b^2 = c^2\\)，块级公式：',
    '\\[\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\\]',
    '',
    '行内代码 `\\(not-math\\)` 和 `$not-math$` 保持原样。',
    '',
    '```python',
    'print("\\[keep-me\\] $HOME")',
    '```',
  ].join('\n');

  const out = prepareMarkdown(input);
  assert.doesNotMatch(out, /\[\[cite:/);
  assert.ok(out.includes('$a^2 + b^2 = c^2$'));
  assert.ok(out.includes('\n$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$\n'));
  assert.ok(out.includes('`\\(not-math\\)`'));
  assert.ok(out.includes('`$not-math$`'));
  assert.ok(out.includes('print("\\[keep-me\\] $HOME")'));
});

test('mp-html component with markdown and latex plugins is built into miniprogram/components/mp-html', () => {
  const compDir = path.join(__dirname, '../../miniprogram/components/mp-html');
  assert.equal(fs.existsSync(path.join(compDir, 'index.js')), true);
  assert.equal(fs.existsSync(path.join(compDir, 'index.wxml')), true);
  assert.equal(fs.existsSync(path.join(compDir, 'markdown/index.js')), true);
  assert.equal(fs.existsSync(path.join(compDir, 'latex/index.js')), true);
});
