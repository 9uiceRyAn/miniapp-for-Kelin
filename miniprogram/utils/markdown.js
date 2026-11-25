const CITE_RE = /\[\[cite:[a-f0-9-]+\]\]/g;

function prepareMarkdown(rawText) {
  const cleaned = String(rawText || '').replace(CITE_RE, '').replace(/\r\n?/g, '\n');
  if (!cleaned) return '';

  const codeBlocks = [];
  const protectCode = (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `\x00MDCODE${idx}\x00`;
  };

  let working = cleaned
    .replace(/```[\s\S]*?```/g, protectCode)
    .replace(/`[^`\n]+`/g, protectCode);

  working = working
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => `\n$$\n${tex.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => `$${tex.trim()}$`);

  return working.replace(/\x00MDCODE(\d+)\x00/g, (_, idx) => codeBlocks[Number(idx)] ?? '');
}

module.exports = { prepareMarkdown };
