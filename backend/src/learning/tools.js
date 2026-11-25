const fs = require('node:fs/promises');
const mathLibrary = require('mathjs');
const math = mathLibrary.create(mathLibrary.all, {
  number: 'BigNumber',
  precision: 64,
});
const c = require('./core'),
  questions = require('./questions'),
  documents = require('./documents'),
  media = require('./media'),
  models = require('./models');
function calculate(expression) {
  if (typeof expression !== 'string' || expression.length > 1000)
    c.fail(400, '计算式无效');
  const ast = math.parse(expression),
    functions = new Set([
      'sin',
      'cos',
      'tan',
      'asin',
      'acos',
      'atan',
      'sqrt',
      'log',
      'log10',
      'exp',
      'abs',
      'round',
      'floor',
      'ceil',
      'factorial',
      'min',
      'max',
    ]);
  let count = 0;
  ast.traverse((node) => {
    if (
      ++count > 500 ||
      ![
        'ConstantNode',
        'OperatorNode',
        'ParenthesisNode',
        'SymbolNode',
        'FunctionNode',
      ].includes(node.type)
    )
      c.fail(400, '仅支持数学表达式');
    if (node.type === 'FunctionNode' && !functions.has(node.fn.name))
      c.fail(400, '不支持此函数');
    if (
      node.type === 'SymbolNode' &&
      !functions.has(node.name) &&
      !['pi', 'e'].includes(node.name)
    )
      c.fail(400, '不支持此变量');
  });
  return String(ast.compile().evaluate());
}
async function call(name, args, context) {
  const invocation = c.id();
  await c.rows('INSERT INTO kl_tools VALUES(?,?,?,?,?)', [
    invocation,
    context.runId,
    name,
    JSON.stringify({ arguments: args, version: 1 }),
    'running',
  ]);
  await context.emit('tool-started', { name, invocationId: invocation });
  try {
    let result;
    if (name === 'search_existing_files') result = await require('./library-agent').searchFiles(args, context);
    else if (name === 'propose_library_change') result = await require('./library-agent').propose(args, context);
    else if (name === 'calculate') result = { value: calculate(args.expression) };
    else if (name === 'search_questions') {
      const found = await questions.list({
        q: args.query,
        subject: args.subject,
        collection: args.collection,
        tag: args.tag,
        pageSize: 5,
      });
      result = {
        ...found,
        items: found.items.map((x) => ({
          resourceId: x.resourceId,
          revisionId: x.revisionId,
          title: x.title,
          source: x.source_ref,
          qualityStatus: x.quality_status,
        })),
      };
    } else if (name === 'search_library')
      result = await documents.search(
        { q: args.query, pageSize: 5 },
        context.user,
      );
    else if (
      name === 'read_library_resource' ||
      name === 'parse_file' ||
      name === 'get_question_image' ||
      name === 'read_image_text'
    ) {
      if (!args.revisionId) c.fail(400, '读取资料必须指定修订');
      const data = await questions.detail(
        context.user,
        args.resourceId,
        args.revisionId,
      );
      if (
        data.visibility === 'private' &&
        !(await c.one(
          'SELECT id FROM kl_assets WHERE resource_id=? AND conversation_id=?',
          [args.resourceId, context.conversationId],
        ))
      )
        c.fail(403, '只能处理当前会话附件');
      const citation = await context.cite({
        resourceId: args.resourceId,
        revisionId: args.revisionId,
        title: data.title,
        position: args.position || null,
        source: data.source_ref,
      });
      result = {
        ...data,
        citationKey: citation,
        details: undefined,
        gallery: undefined,
        image: undefined,
        audio: undefined,
        chunkCount: data.chunks.length,
        chunks: data.chunks
          .filter((x) => !args.position || x.position === Number(args.position))
          .slice(0, 8),
      };
      if (name === 'get_question_image' || name === 'read_image_text') {
        const images = await c.rows(
          "SELECT * FROM kl_media WHERE revision_id=? AND storage_path IS NOT NULL AND mime LIKE 'image/%'" +
            (args.mediaId ? ' AND id=?' : '') +
            ' ORDER BY position,id LIMIT 3',
          args.mediaId ? [args.revisionId, args.mediaId] : [args.revisionId],
        );
        result.mediaList = await c.rows(
          "SELECT id,kind,label,position FROM kl_media WHERE revision_id=? AND mime LIKE 'image/%' ORDER BY position,id",
          [args.revisionId],
        );
        result.images = [];
        for (const image of images)
          result.images.push({
            id: image.id,
            kind: image.kind,
            label: image.label,
            text: await documents.vision(
              await fs.readFile(media.absolute(image.storage_path)),
              image.mime,
              context,
            ),
          });
        result.remainingMedia = result.mediaList.filter(
          (x) => !images.some((image) => image.id === x.id),
        );
        if (!images.length) c.fail(404, '此修订没有可读图片');
      }
      if (data.status !== 'ready')
        c.fail(409, '资料尚未解析成功，请查看解析状态');
    } else if (name === 'web_search') {
      if (!process.env.TAVILY_API_KEY) c.fail(503, '平台尚未配置联网搜索');
      const operation = c.id();
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + process.env.TAVILY_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: args.query,
          max_results: 5,
          include_usage: true,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        await models.record(context, operation, 'tavily', null, null, {
          incomplete: true,
        });
        c.fail(502, '搜索服务请求失败');
      }
      const data = await response.json();
      result = { results: [] };
      for (const entry of data.results || [])
        result.results.push({
          ...entry,
          citationKey: await context.cite({
            title: entry.title,
            url: entry.url,
            snippet: entry.content,
            accessedAt: new Date().toISOString(),
          }),
        });
      await models.record(
        context,
        operation,
        'tavily',
        null,
        await models.price('tavily'),
        { requestId: data.request_id, credits: data.usage?.credits },
      );
    } else c.fail(400, '未知工具');
    await c.rows("UPDATE kl_tools SET status='completed',data=? WHERE id=?", [
      JSON.stringify({ arguments: args, result }),
      invocation,
    ]);
    await context.emit('tool-completed', { name, invocationId: invocation });
    return result;
  } catch (e) {
    await c.rows("UPDATE kl_tools SET status='failed',data=? WHERE id=?", [
      JSON.stringify({
        arguments: args,
        error: e.status ? e.message : '工具执行失败',
      }),
      invocation,
    ]);
    await context.emit('tool-failed', {
      name,
      message: e.status ? e.message : '工具执行失败',
    });
    return { error: e.status ? e.message : '工具执行失败' };
  }
}
module.exports = { call, calculate };
