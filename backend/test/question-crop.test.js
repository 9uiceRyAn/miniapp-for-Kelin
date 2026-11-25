const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

process.env.MEDIA_SIGNING_KEY ||= 'test-media-signing-key';

const c = require('../src/learning/core');
const media = require('../src/learning/media');
const questions = require('../src/learning/questions');
const questionCrop = require('../src/learning/question-crop');

function buildMinimalPdf(lines) {
  const streamLines = ['BT', '/F1 12 Tf'];
  for (const { x, y, text } of lines) {
    const escaped = String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    streamLines.push(`1 0 0 1 ${x} ${y} Tm (${escaped}) Tj`);
  }
  streamLines.push('ET');
  const stream = streamLines.join('\n');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

test('crop tools reject non-teacher users', async () => {
  const student = { id: 2, role: 'student' };
  await assert.rejects(
    () => questionCrop.inspectPdfLayout({ resourceId: 'r1', revisionId: 'rev1' }, { user: student }),
    /教师/,
  );
  await assert.rejects(
    () => questionCrop.cropAttachmentImage({ resourceId: 'r1', revisionId: 'rev1', regions: [{ top: 0.1, bottom: 0.5 }] }, { user: student }),
    /教师/,
  );
});

test('cropAttachmentImage stitches two regions from a PNG attachment and returns a valid upload token', async (t) => {
  const canvas = await import('@napi-rs/canvas');
  const img = canvas.createCanvas(400, 600);
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, 400, 600);
  ctx.fillStyle = '#111111';
  ctx.fillRect(20, 40, 360, 100);
  ctx.fillRect(20, 320, 360, 100);
  const pngBytes = await img.encode('png');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kelin-crop-png-'));
  const origDetail = questions.detail;
  const origOne = c.one;
  const origAbsolute = media.absolute;
  const origBlob = media.blob;
  t.after(async () => {
    questions.detail = origDetail;
    c.one = origOne;
    media.absolute = origAbsolute;
    media.blob = origBlob;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const srcPath = path.join(tmpDir, 'source.png');
  await fs.writeFile(srcPath, pngBytes);
  questions.detail = async () => ({ visibility: 'private' });
  c.one = async (sql) => {
    if (sql.includes('FROM kl_assets')) return { id: 'asset-1' };
    if (sql.includes('FROM kl_media')) return { storage_path: 'source.png', mime: 'image/png', original_path: 'source.png' };
    return null;
  };
  media.absolute = (rel) => path.join(tmpDir, rel);
  media.blob = async (bytes, ext) => {
    const out = path.join(tmpDir, 'out' + ext);
    await fs.writeFile(out, bytes);
    return { path: 'out' + ext, hash: c.hash(bytes) };
  };

  const res = await questionCrop.cropAttachmentImage(
    {
      resourceId: 'res-1',
      revisionId: 'rev-1',
      regions: [
        { top: 0.05, bottom: 0.30, left: 0.0, right: 1.0 },
        { top: 0.50, bottom: 0.75, left: 0.0, right: 1.0 },
      ],
      kind: 'question',
      label: 'Q1 拼接图',
      fileName: 'q1-stitched.png',
    },
    { user: { id: 1, role: 'teacher' }, conversationId: 'conv-1' },
  );

  assert.ok(res.token && res.token.includes('.'));
  assert.equal(res.kind, 'question');
  assert.equal(res.label, 'Q1 拼接图');
  assert.equal(res.width, 400 + 40);
  assert.equal(res.height, 150 + 150 + 16 + 40);
  const outBytes = await fs.readFile(path.join(tmpDir, 'out.png'));
  assert.deepEqual(outBytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
});

test('inspectPdfLayout and cropAttachmentImage separate two questions on the same PDF page', async (t) => {
  const pdfBytes = buildMinimalPdf([
    { x: 50, y: 740, text: '7  First question about demand and supply.' },
    { x: 50, y: 700, text: '   Calculate the equilibrium price.' },
    { x: 50, y: 420, text: '8  Second question about market failure.' },
    { x: 50, y: 380, text: '   Explain one government intervention.' },
  ]);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kelin-crop-pdf-'));
  const origDetail = questions.detail;
  const origOne = c.one;
  const origAbsolute = media.absolute;
  const origBlob = media.blob;
  t.after(async () => {
    questions.detail = origDetail;
    c.one = origOne;
    media.absolute = origAbsolute;
    media.blob = origBlob;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  await fs.writeFile(path.join(tmpDir, 'paper.pdf'), pdfBytes);
  questions.detail = async () => ({ visibility: 'public' });
  c.one = async (sql) => {
    if (sql.includes('FROM kl_media')) return { storage_path: 'paper.pdf', mime: 'application/pdf', original_path: 'paper.pdf' };
    return null;
  };
  media.absolute = (rel) => path.join(tmpDir, rel);
  media.blob = async (bytes, ext) => {
    const out = path.join(tmpDir, 'crop' + ext);
    await fs.writeFile(out, bytes);
    return { path: 'crop' + ext, hash: c.hash(bytes) };
  };

  const ctx = { user: { id: 1, role: 'teacher' }, conversationId: 'conv-1' };
  const layout = await questionCrop.inspectPdfLayout({ resourceId: 'res-pdf', revisionId: 'rev-pdf' }, ctx);
  assert.equal(layout.pageCount, 1);
  assert.equal(layout.pages.length, 1);
  assert.equal(layout.pages[0].isScanned, false);
  const q7Line = layout.pages[0].lines.find((l) => l.text.includes('7'));
  const q8Line = layout.pages[0].lines.find((l) => l.text.includes('8'));
  assert.ok(q7Line && q8Line);
  assert.ok(q7Line.yTop < q8Line.yTop);

  const croppedQ7 = await questionCrop.cropAttachmentImage(
    {
      resourceId: 'res-pdf',
      revisionId: 'rev-pdf',
      regions: [{ page: 1, top: Math.max(0, q7Line.yTop - 0.02), bottom: q8Line.yTop - 0.02 }],
      kind: 'question',
      label: 'Q7',
      fileName: 'q7.png',
    },
    ctx,
  );
  assert.ok(croppedQ7.token && croppedQ7.bytes > 100);
  const outBytes = await fs.readFile(path.join(tmpDir, 'crop.png'));
  assert.deepEqual(outBytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
});
