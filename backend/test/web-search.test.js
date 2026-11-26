const { test } = require('node:test');
const assert = require('node:assert/strict');
const { searxngSearch } = require('../src/learning/tools');

test('searxngSearch queries SearXNG JSON endpoint, limits to 5 results, and cites sources', async (t) => {
  const prevUrl = process.env.SEARXNG_BASE_URL;
  const prevLang = process.env.SEARXNG_LANGUAGE;
  const prevEngines = process.env.SEARXNG_ENGINES;
  process.env.SEARXNG_BASE_URL = 'http://127.0.0.1:8080/';
  process.env.SEARXNG_LANGUAGE = 'zh-CN';
  process.env.SEARXNG_ENGINES = 'bing,baidu';
  t.after(() => {
    if (prevUrl !== undefined) process.env.SEARXNG_BASE_URL = prevUrl;
    else delete process.env.SEARXNG_BASE_URL;
    if (prevLang !== undefined) process.env.SEARXNG_LANGUAGE = prevLang;
    else delete process.env.SEARXNG_LANGUAGE;
    if (prevEngines !== undefined) process.env.SEARXNG_ENGINES = prevEngines;
    else delete process.env.SEARXNG_ENGINES;
  });

  let requestedUrl = '';
  t.mock.method(global, 'fetch', async (url) => {
    requestedUrl = url;
    return new Response(
      JSON.stringify({
        results: Array.from({ length: 7 }, (_, i) => ({
          title: `Result ${i + 1}`,
          url: `https://example.com/${i + 1}`,
          content: `Snippet ${i + 1}`,
          engine: 'bing',
        })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  const cited = [];
  const res = await searxngSearch('A-Level 物理', {
    cite: async (entry) => {
      cited.push(entry);
      return `web-${cited.length}`;
    },
  });

  const parsed = new URL(requestedUrl);
  assert.equal(parsed.origin + parsed.pathname, 'http://127.0.0.1:8080/search');
  assert.equal(parsed.searchParams.get('q'), 'A-Level 物理');
  assert.equal(parsed.searchParams.get('format'), 'json');
  assert.equal(parsed.searchParams.get('language'), 'zh-CN');
  assert.equal(parsed.searchParams.get('engines'), 'bing,baidu');

  assert.equal(res.results.length, 5);
  assert.equal(res.results[0].citationKey, 'web-1');
  assert.equal(res.results[4].title, 'Result 5');
  assert.equal(cited.length, 5);
});

test('searxngSearch validates empty query and handles upstream errors', async (t) => {
  await assert.rejects(
    searxngSearch('   ', { cite: async () => 'x' }),
    (err) => err.status === 400 && /关键词/.test(err.message),
  );

  const prevUrl = process.env.SEARXNG_BASE_URL;
  process.env.SEARXNG_BASE_URL = 'http://127.0.0.1:8080';
  t.after(() => {
    if (prevUrl !== undefined) process.env.SEARXNG_BASE_URL = prevUrl;
    else delete process.env.SEARXNG_BASE_URL;
  });

  t.mock.method(global, 'fetch', async () => new Response('Bad Gateway', { status: 502 }));
  await assert.rejects(
    searxngSearch('test', { cite: async () => 'x' }),
    (err) => err.status === 502 && /搜索服务/.test(err.message),
  );
  t.mock.method(global, 'fetch', async () => new Response('<html>Proxy login</html>'));
  await assert.rejects(searxngSearch('test', {}), (err) => err.status === 502);
});
