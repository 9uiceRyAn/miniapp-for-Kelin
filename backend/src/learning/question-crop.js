const fs = require('node:fs/promises');
const path = require('node:path');
const c = require('./core');
const media = require('./media');
const questions = require('./questions');
const management = require('./question-management');

const VALID_KINDS = new Set(['question', 'answer', 'ms', 'sm', 'source']);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

async function loadCanvasAndPdfjs() {
  const canvas = await import('@napi-rs/canvas');
  globalThis.DOMMatrix ||= canvas.DOMMatrix;
  globalThis.Path2D ||= canvas.Path2D;
  globalThis.ImageData ||= canvas.ImageData;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return { canvas, pdfjs };
}

async function loadOriginalAttachment(args, context) {
  c.teacher(context.user);
  if (!args?.resourceId || !args?.revisionId) {
    c.fail(400, '必须提供附件的 resourceId 和 revisionId');
  }
  const data = await questions.detail(context.user, args.resourceId, args.revisionId);
  if (
    data.visibility === 'private' &&
    !(await c.one(
      'SELECT id FROM kl_assets WHERE resource_id=? AND conversation_id=?',
      [args.resourceId, context.conversationId],
    ))
  ) {
    c.fail(403, '只能处理当前会话附件');
  }
  const original = await c.one(
    "SELECT * FROM kl_media WHERE revision_id=? AND kind='original' AND storage_path IS NOT NULL LIMIT 1",
    [args.revisionId],
  );
  if (!original) {
    c.fail(404, '未找到该附件的原始文件');
  }
  const bytes = await fs.readFile(media.absolute(original.storage_path));
  return { data, original, bytes };
}

function groupLines(items, viewport) {
  const tokens = [];
  for (const item of items) {
    const str = String(item.str || '').replace(/\s+/g, ' ').trim();
    if (!str) continue;
    const tx = Array.isArray(item.transform) ? Number(item.transform[4] || 0) : 0;
    const ty = Array.isArray(item.transform) ? Number(item.transform[5] || 0) : 0;
    const h = Math.abs(Number(item.height || item.transform?.[3] || 10)) || 10;
    const [x0, y0] = viewport.convertToViewportPoint(tx, ty);
    const [x1, y1] = viewport.convertToViewportPoint(tx + Number(item.width || 0), ty + h);
    const xLeft = clamp(Math.min(x0, x1) / viewport.width, 0, 1);
    const yBottom = clamp(Math.max(y0, y1) / viewport.height, 0, 1);
    const yTop = clamp(Math.min(y0, y1) / viewport.height, 0, 1);
    tokens.push({ xLeft, yTop, yBottom, text: str });
  }
  tokens.sort((a, b) => a.yTop - b.yTop || a.xLeft - b.xLeft);
  const lines = [];
  for (const tok of tokens) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(tok.yTop - last.yTop) <= 0.008) {
      last.parts.push(tok);
      last.yTop = Math.min(last.yTop, tok.yTop);
      last.yBottom = Math.max(last.yBottom, tok.yBottom);
    } else {
      lines.push({ yTop: tok.yTop, yBottom: tok.yBottom, xLeft: tok.xLeft, parts: [tok] });
    }
  }
  return lines.slice(0, 120).map((line) => {
    line.parts.sort((a, b) => a.xLeft - b.xLeft);
    return {
      yTop: round4(line.yTop),
      yBottom: round4(line.yBottom),
      xLeft: round4(line.parts[0].xLeft),
      text: line.parts.map((p) => p.text).join(' '),
    };
  });
}

async function inspectPdfLayout(args, context) {
  const { original, bytes } = await loadOriginalAttachment(args, context);
  if (original.mime !== 'application/pdf' && path.extname(original.original_path || '').toLowerCase() !== '.pdf') {
    c.fail(400, 'inspect_pdf_layout 仅支持 PDF 附件');
  }
  const { pdfjs } = await loadCanvasAndPdfjs();
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const pdf = await loading.promise;
  try {
    let targetPages;
    if (Array.isArray(args.pages) && args.pages.length) {
      targetPages = [...new Set(args.pages.map((n) => Math.floor(Number(n))).filter((n) => n >= 1 && n <= pdf.numPages))].slice(0, 10);
    } else {
      const limit = Math.min(pdf.numPages, 6);
      targetPages = Array.from({ length: limit }, (_, idx) => idx + 1);
    }
    const pages = [];
    for (const pageNum of targetPages) {
      const page = await pdf.getPage(pageNum);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const lines = groupLines(content.items || [], viewport);
        pages.push({
          page: pageNum,
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
          lineCount: lines.length,
          isScanned: lines.length < 2,
          lines,
        });
      } finally {
        page.cleanup();
      }
    }
    return { pageCount: pdf.numPages, pages };
  } finally {
    await loading.destroy();
  }
}

async function cropAttachmentImage(args, context) {
  const { original, bytes } = await loadOriginalAttachment(args, context);
  const rawRegions = Array.isArray(args.regions) ? args.regions : [];
  if (!rawRegions.length || rawRegions.length > 6) {
    c.fail(400, 'regions 必须包含 1 到 6 个裁切区域');
  }
  const regions = rawRegions.map((r, idx) => {
    const top = clamp(Number(r?.top), 0, 1);
    const bottom = clamp(Number(r?.bottom), 0, 1);
    const left = clamp(r?.left === undefined ? 0 : Number(r.left), 0, 1);
    const right = clamp(r?.right === undefined ? 1 : Number(r.right), 0, 1);
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom - top < 0.02) {
      c.fail(400, `第 ${idx + 1} 个裁切区域纵向范围无效（bottom - top 须 >= 0.02）`);
    }
    if (!Number.isFinite(left) || !Number.isFinite(right) || right - left < 0.05) {
      c.fail(400, `第 ${idx + 1} 个裁切区域横向范围无效（right - left 须 >= 0.05）`);
    }
    const page = r?.page === undefined ? 1 : Math.floor(Number(r.page));
    if (!Number.isFinite(page) || page < 1) {
      c.fail(400, `第 ${idx + 1} 个裁切区域页码无效`);
    }
    return { page, top, bottom, left, right };
  });

  const isPdf =
    original.mime === 'application/pdf' ||
    path.extname(original.original_path || '').toLowerCase() === '.pdf';
  const { canvas, pdfjs } = await loadCanvasAndPdfjs();
  const croppedParts = [];

  if (isPdf) {
    const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const pdf = await loading.promise;
    const pageCache = new Map();
    let renderedPixels = 0;
    try {
      for (const r of regions) {
        if (r.page > pdf.numPages) {
          c.fail(400, `页码 ${r.page} 超出 PDF 总页数（${pdf.numPages}）`);
        }
        let rendered = pageCache.get(r.page);
        if (!rendered) {
          const page = await pdf.getPage(r.page);
          try {
            const viewport = page.getViewport({ scale: 2.0 });
            renderedPixels += Math.ceil(viewport.width) * Math.ceil(viewport.height);
            if (renderedPixels > 24_000_000) c.fail(400, 'PDF 页面过大，请缩小页面或分批裁切');
            const pageCanvas = canvas.createCanvas(
              Math.ceil(viewport.width),
              Math.ceil(viewport.height),
            );
            const pctx = pageCanvas.getContext('2d');
            pctx.fillStyle = '#FFFFFF';
            pctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
            await page.render({ canvasContext: pctx, canvas: pageCanvas, viewport }).promise;
            rendered = pageCanvas;
            pageCache.set(r.page, rendered);
          } finally {
            page.cleanup();
          }
        }
        const sx = Math.floor(r.left * rendered.width);
        const sy = Math.floor(r.top * rendered.height);
        const sw = Math.max(1, Math.ceil((r.right - r.left) * rendered.width));
        const sh = Math.max(1, Math.ceil((r.bottom - r.top) * rendered.height));
        croppedParts.push({ source: rendered, sx, sy, sw, sh });
      }
    } finally {
      await loading.destroy();
    }
  } else if (String(original.mime || '').startsWith('image/')) {
    const img = await canvas.loadImage(bytes);
    for (const r of regions) {
      const sx = Math.floor(r.left * img.width);
      const sy = Math.floor(r.top * img.height);
      const sw = Math.max(1, Math.ceil((r.right - r.left) * img.width));
      const sh = Math.max(1, Math.ceil((r.bottom - r.top) * img.height));
      croppedParts.push({ source: img, sx, sy, sw, sh });
    }
  } else {
    c.fail(400, 'crop_attachment_image 仅支持 PDF 或图片附件');
  }

  const padding = 20;
  const gap = 16;
  const maxWidth = Math.max(...croppedParts.map((p) => p.sw));
  const totalHeight =
    padding * 2 +
    croppedParts.reduce((sum, p) => sum + p.sh, 0) +
    gap * Math.max(0, croppedParts.length - 1);
  const outWidth = maxWidth + padding * 2;
  if (outWidth * totalHeight > 24_000_000) c.fail(400, '拼接题图过大，请分批裁切');
  const outCanvas = canvas.createCanvas(outWidth, totalHeight);
  const outCtx = outCanvas.getContext('2d');
  outCtx.fillStyle = '#FFFFFF';
  outCtx.fillRect(0, 0, outWidth, totalHeight);

  let y = padding;
  for (const part of croppedParts) {
    outCtx.drawImage(part.source, part.sx, part.sy, part.sw, part.sh, padding, y, part.sw, part.sh);
    y += part.sh + gap;
  }

  const pngBuffer = await outCanvas.encode('png');
  const rawName = String(args.fileName || 'crop.png').trim() || 'crop.png';
  const safeBase = path.basename(rawName, path.extname(rawName)).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_') || 'crop';
  const safeFileName = safeBase + '.png';
  const uploaded = await management.upload(context.user, pngBuffer, safeFileName);
  const kind = VALID_KINDS.has(args.kind) ? args.kind : 'question';

  return {
    token: uploaded.token,
    kind,
    label: String(args.label || safeFileName).trim().slice(0, 191),
    width: outWidth,
    height: totalHeight,
    bytes: pngBuffer.length,
  };
}

module.exports = { inspectPdfLayout, cropAttachmentImage };
