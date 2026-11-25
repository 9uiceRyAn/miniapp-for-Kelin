const c = require('./core'),
  agents = require('./agents');
let renderer;
function mathSvg(tex, display) {
  if (!renderer) {
    const { mathjax } = require('mathjax-full/js/mathjax.js'),
      { TeX } = require('mathjax-full/js/input/tex.js'),
      { SVG } = require('mathjax-full/js/output/svg.js'),
      { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js'),
      { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js'),
      { AllPackages } = require('mathjax-full/js/input/tex/AllPackages.js');
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    renderer = {
      adaptor,
      document: mathjax.document('', {
        InputJax: new TeX({ packages: AllPackages }),
        OutputJax: new SVG({ fontCache: 'none' }),
      }),
    };
  }
  const node = renderer.document.convert(tex, { display });
  return renderer.adaptor.outerHTML(renderer.adaptor.firstChild(node));
}
async function readableMessage(user, messageId) {
  const message = await c.one('SELECT * FROM kl_messages WHERE id=?', [
    messageId,
  ]);
  if (!message) c.fail(404, '消息不存在');
  await agents.getConversation(user, message.conversation_id);
  return message;
}
async function render(user, messageId) {
  const message = await readableMessage(user, messageId);
  const data = c.json(message.data),
    formulas = [],
    text = String(data.text || '').replace(/\[\[cite:[a-f0-9-]+\]\]/g, '');
  const substituted = text.replace(
    /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\$)\$([^\n$]+)\$(?!\$)/g,
    (whole, ...args) => {
      const tex = args.slice(0, 4).find((x) => x !== undefined);
      try {
        const svg = mathSvg(
            tex,
            whole.startsWith('$$') || whole.startsWith('\\['),
          ),
          hash = c.hash(svg);
        formulas.push({ hash, svg });
        return '\n\nKELINFORMULA' + hash + '\n\n';
      } catch {
        return whole;
      }
    },
  );
  const { marked } = await import('marked');
  const nodes = marked.lexer(substituted).flatMap((token) => {
    if (token.type === 'space') return [];
    if (token.type === 'list')
      return [
        {
          name: 'ul',
          children: token.items.map((x) => ({
            name: 'li',
            children: [{ type: 'text', text: x.text }],
          })),
        },
      ];
    const segments = String(token.text || token.raw || '').split(
      /(KELINFORMULA[a-f0-9]{64})/g,
    );
    return segments
      .filter(Boolean)
      .map((text) =>
        text.startsWith('KELINFORMULA')
          ? {
              name: 'img',
              attrs: {
                src: 'formula:' + text.slice(12),
                style: 'max-width:100%;height:auto;',
              },
            }
          : {
              name: token.type === 'heading' ? 'h' + token.depth : 'p',
              children: [
                { type: 'text', text: text.replace(/\*\*([^*]+)\*\*/g, '$1') },
              ],
            },
      );
  });
  if (formulas.length) {
    await c.rows('UPDATE kl_messages SET data=? WHERE id=?', [
      JSON.stringify({
        ...data,
        formulas: formulas.map(({ hash, svg }) => ({ hash, svg })),
      }),
      messageId,
    ]);
  }
  return {
    nodes,
    formulas: formulas.map((x) => ({
      hash: x.hash,
      path: `/api/ai/messages/${messageId}/formulas/${x.hash}`,
    })),
  };
}
async function formula(user, messageId, hash) {
  const message = await readableMessage(user, messageId);
  const item = c.json(message.data).formulas?.find((x) => x.hash === hash);
  if (!item) c.fail(404, '公式不存在');
  return item.svg;
}
module.exports = { render, formula };
