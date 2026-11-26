async function loadPdfRuntime() {
  const canvas = await import('@napi-rs/canvas');
  globalThis.DOMMatrix ||= canvas.DOMMatrix;
  globalThis.Path2D ||= canvas.Path2D;
  globalThis.ImageData ||= canvas.ImageData;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return { canvas, pdfjs };
}

module.exports = { loadPdfRuntime };
