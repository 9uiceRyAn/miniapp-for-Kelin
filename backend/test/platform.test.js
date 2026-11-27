const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  http = require('node:http'),
  os = require('node:os');
const crypto = require('node:crypto');
const enabled = Boolean(process.env.TEST_MYSQL_PORT);
test(
  'real MySQL / HTTP / Mastra integration',
  { skip: !enabled },
  async (t) => {
    process.env.DB_HOST = '127.0.0.1';
    process.env.DB_PORT = process.env.TEST_MYSQL_PORT;
    process.env.DB_USER = 'root';
    process.env.DB_PASSWORD = '';
    process.env.DB_NAME = 'kelin_test_' + process.pid;
    process.env.MEDIA_SIGNING_KEY = 'test-only-signing-key';
    const local = await fs.mkdtemp(path.join(os.tmpdir(), 'kelin-test-'));
    process.env.UPLOAD_ROOT = path.join(local, 'files');
    process.env.LEARNING_STORAGE_ROOT = path.join(local, 'learning');
    process.env.REGISTRATION_CODE_KEY = crypto.randomBytes(32).toString('hex');
    const mysql = require('mysql2/promise');
    const connection = await mysql.createConnection({
      host: '127.0.0.1',
      port: Number(process.env.TEST_MYSQL_PORT),
      user: 'root',
      password: '',
    });
    await connection.query(
      'CREATE DATABASE IF NOT EXISTS `' +
        process.env.DB_NAME +
        '` CHARACTER SET utf8mb4',
    );
    await connection.changeUser({ database: process.env.DB_NAME });
    const baseline = await fs.readFile(
      path.join(__dirname, 'fixtures/base.sql'),
      'utf8',
    );
    for (const sql of baseline.split(';').filter((x) => x.trim()))
      await connection.query(sql);
    // Production's files table predates the learning tables. New columns inherit its collation.
    await connection.query('ALTER TABLE files DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    const testPool = require('../src/db').pool;
    const c = require('../src/learning/core'),
      questions = require('../src/learning/questions'),
      agents = require('../src/learning/agents'),
      runs = require('../src/learning/runs'),
      docs = require('../src/learning/documents'),
      media = require('../src/learning/media');
    require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, '../scripts/learning.js'), 'migrate']);
    const { encrypt } = require('../src/registration-codes');
    for (const role of ['teacher', 'student']) {
      await testPool.execute(
        'INSERT INTO registration_codes(role,encrypted_code) VALUES(?,?)',
        [role, encrypt('test-' + role)],
      );
    }
    let calls = 0;
    const gatewayModels = new Map();
    const gateway = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader('Content-Type', 'application/json');
      const key = req.url === '/v1/chat/completions' ? 'test-inference-key' : 'test-model-admin-key';
      if (req.headers.authorization !== 'Bearer ' + key) {
        res.statusCode = 403;
        return res.end('{}');
      }
      if (req.url === '/model/new') {
        gatewayModels.set(body.model_name, body);
        return res.end(JSON.stringify({ model_info: body.model_info }));
      }
      if (req.url === '/model/update') return res.end('{}');
      if (req.url === '/v1/chat/completions') {
        calls++;
        const prompt = JSON.stringify(body.messages);
        const answer = prompt.includes('教学助手创建顾问')
          ? '```json\n' +
            JSON.stringify({
              name: '数学辅导',
              description: '逐步讲解',
              content: '# 数学辅导\n先引导学生思考，再展示步骤。',
              references: [],
            }) +
            '\n```'
          : '已读取材料，计算结果为 4。';
        if (!body.stream)
          return res.end(
            JSON.stringify({
              id: 'fake-' + calls,
              choices: [
                {
                  message: body.tool_choice
                    ? {
                        role: 'assistant',
                        tool_calls: [
                          {
                            id: 'probe-call',
                            type: 'function',
                            function: {
                              name: 'connection_probe',
                              arguments: '{}',
                            },
                          },
                        ],
                      }
                    : { role: 'assistant', content: answer },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 20 },
            }),
          );
        res.setHeader('Content-Type', 'text/event-stream');
        const chunk = (delta) =>
          res.write(
            'data: ' +
              JSON.stringify({
                id: 'fake-' + calls,
                object: 'chat.completion.chunk',
                created: 1,
                model: body.model,
                choices: [{ index: 0, delta, finish_reason: null }],
              }) +
              '\n\n',
          );
        chunk({ role: 'assistant' });
        if (
          prompt.includes('USE_CALCULATOR') &&
          !body.messages.some((m) => m.role === 'tool')
        ) {
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'call-calc',
                type: 'function',
                function: {
                  name: 'calculate',
                  arguments: '{"expression":"2+2"}',
                },
              },
            ],
          });
          res.write(
            'data: ' +
              JSON.stringify({
                id: 'fake-' + calls,
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 100, completion_tokens: 20 },
              }) +
              '\n\n',
          );
        } else {
          chunk({ content: answer });
          res.write(
            'data: ' +
              JSON.stringify({
                id: 'fake-' + calls,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 100, completion_tokens: 20 },
              }) +
              '\n\n',
          );
        }
        return res.end('data: [DONE]\n\n');
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    process.env.LITELLM_BASE_URL = 'http://127.0.0.1:' + gateway.address().port;
    process.env.LITELLM_MODEL_ADMIN_KEY = 'test-model-admin-key';
    process.env.LITELLM_CALL_KEY = 'test-inference-key';
    const app = require('../src/server'),
      server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.on('listening', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const managementTokens = new Map();
    process.env.ADMIN_MANAGEMENT_PASSWORD_HASH = require('../src/utils/security').hashPassword('fixture-admin');
    const api = async (method, url, body, token, expected = 200) => {
      const response = await fetch(origin + url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(managementTokens.has(token) ? { 'X-Management-Token': managementTokens.get(token) } : {}),
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      assert.equal(response.status, expected, JSON.stringify({ url, data }));
      return data.data;
    };
    const users = [];
    try {
      for (const [username, role] of [
        ['teacher1', 'teacher'],
        ['teacher2', 'teacher'],
        ['student1', 'student'],
        ['student2', 'student'],
        ['platformadmin', 'student'],
      ]) {
        await api('POST', '/api/auth/register', {
          username,
          role,
          password: 'test-password',
          registerCode: role === 'teacher' ? 'test-teacher' : 'test-student',
        });
        users.push(
          await api('POST', '/api/auth/login', {
            username,
            password: 'test-password',
            rememberDevice: false,
          }),
        );
      }
      const [teacher, otherTeacher, student, otherStudent] = users;
      await api('GET', '/api/ai/admin/models', null, teacher.token, 403);
      const grant = await api('POST', '/api/ai/admin/unlock', { password: 'fixture-admin' }, teacher.token);
      managementTokens.set(teacher.token, grant.token);
      const tu = { id: teacher.user.id, role: 'teacher' },
        su = { id: student.user.id, role: 'student' },
        ot = { id: otherTeacher.user.id, role: 'teacher' };
      let model, agent, conversation, resource, revision, signedMediaPath;
      await t.test(
        'model management is administrator-only and never returns upstream credentials',
        async () => {
          await api(
            'POST',
            '/api/ai/admin/models',
            { name: 'forbidden' },
            student.token,
            403,
          );
          model = await api(
            'POST',
            '/api/ai/admin/models',
            {
              name: 'Test model',
              baseURL: 'https://api.example.com/v1',
              upstreamModel: 'openai/test',
              apiKey: 'not-a-real-secret',
              capabilities: { text: true, tools: true, vision: true },
            },
            teacher.token,
          );
          assert.ok(!JSON.stringify(model).includes('not-a-real-secret'));
          await api(
            'POST',
            '/api/ai/admin/prices',
            {
              modelId: model.id,
              currency: 'USD',
              rates: { input: '1', output: '2', cachedInput: '0.1' },
            },
            teacher.token,
          );
          for (const kind of ['text', 'tools', 'vision'])
            await api(
              'POST',
              '/api/ai/admin/models/' + model.id + '/test',
              { kind },
              teacher.token,
            );
          await api(
            'PUT',
            '/api/ai/admin/settings',
            { builderModelId: model.id, visionModelId: model.id },
            teacher.token,
          );
        },
      );
      await t.test(
        'question import is idempotent, collection tags are isolated, media and metadata create immutable revisions',
        async () => {
          await fs.mkdir(path.join(local, 'source'));
          await fs.writeFile(
            path.join(local, 'source', 'q.png'),
            Buffer.from('test-image'),
          );
          const item = {
            id: 'Q1',
            subject: 'math',
            collection: 'one',
            title: '积分 Q1',
            tags: ['1.1'],
            tag_names: { 1.1: '积分' },
            gallery: [
              { kind: 'question', path: 'q.png', label: '题目' },
              { kind: 'unknown', path: 'missing.png', label: '未知材料' },
            ],
            audio: [],
            search_text: '积分 Q1',
            quality_status: 'review_required',
            review_required: true,
          };
          const input = {
            items: [
              item,
              {
                ...item,
                collection: 'two',
                title: '另一个数据集',
                tags: ['1.1'],
              },
            ],
            baseDirectory: path.join(local, 'source'),
            allowedRoot: local,
          };
          let report = await questions.importQuestions(input);
          assert.equal(report.created, 2);
          assert.equal(report.missingMedia.length, 2);
          report = await questions.importQuestions(input);
          assert.equal(report.unchanged, 2);
          const list = await questions.list({
            collection: 'one',
            tag: '1.1',
            q: '积分',
          });
          assert.equal(list.total, 1);
          resource = list.items[0].resourceId;
          revision = list.items[0].revisionId;
          await fs.writeFile(
            path.join(local, 'source', 'q.png'),
            'updated-image',
          );
          report = await questions.importQuestions(input);
          assert.equal(report.revisions, 2);
          const old = await questions.detail(su, resource, revision);
          assert.equal(old.title, '积分 Q1');
          assert.equal(
            (await questions.list({ collection: 'one' })).items[0]
              .revisionId === revision,
            false,
          );
          await assert.rejects(
            questions.importQuestions({ ...input, items: [item, item] }),
          );
        },
      );
      await t.test(
        'media tickets preserve bytes, support Range and stop working after session revocation',
        async () => {
          const detail = await api(
            'GET',
            `/api/question-bank/items/${resource}/revisions/${revision}`,
            null,
            student.token,
          );
          assert.equal(detail.media.length, 2);
          assert.equal(detail.media[1].available, false);
          signedMediaPath = detail.media[0].path;
          const response = await fetch(origin + detail.media[0].path, {
            headers: { Range: 'bytes=0-3' },
          });
          assert.equal(response.status, 206);
          assert.equal(await response.text(), 'test');
          await api('GET', '/api/question-bank/items', null, null, 401);
          const tampered = await fetch(origin + detail.media[0].path + 'x');
          assert.equal(tampered.status, 401);
        },
      );
      await t.test(
        'publishing and test conversations keep immutable skills/models; teachers can maintain the shared draft',
        async () => {
          agent = await api(
            'POST',
            '/api/ai/agents',
            { name: 'Math' },
            teacher.token,
          );
          await api(
            'PUT',
            `/api/ai/agents/${agent.id}/draft`,
            { name: 'Math', content: 'v1 instructions', modelId: model.id },
            teacher.token,
          );
          const v1 = await api(
            'POST',
            `/api/ai/agents/${agent.id}/publish`,
            {},
            teacher.token,
          );
          conversation = await api(
            'POST',
            '/api/ai/conversations',
            { agentId: agent.id },
            student.token,
          );
          const trial = await api(
            'POST',
            `/api/ai/agents/${agent.id}/test-conversations`,
            {},
            teacher.token,
          );
          await api(
            'PUT',
            `/api/ai/agents/${agent.id}/draft`,
            { name: 'Math', content: 'v2 instructions', modelId: model.id },
            teacher.token,
          );
          await api(
            'POST',
            `/api/ai/agents/${agent.id}/publish`,
            {},
            teacher.token,
          );
          assert.equal(
            (await agents.getConversation(su, conversation.id)).snapshot.skill
              .content,
            'v1 instructions',
          );
          assert.equal(
            (await agents.getConversation(tu, trial.id)).snapshot.skill.content,
            'v1 instructions',
          );
          await api(
            'PUT',
            `/api/ai/agents/${agent.id}/draft`,
            { name: 'Math', content: 'shared draft', modelId: model.id },
            otherTeacher.token,
          );
          await api(
            'GET',
            `/api/ai/conversations/${conversation.id}`,
            null,
            otherStudent.token,
            403,
          );
          await api(
            'GET',
            `/api/ai/conversations/${conversation.id}`,
            null,
            otherTeacher.token,
            403,
          );
          await api(
            'GET',
            `/api/ai/conversations/${conversation.id}`,
            null,
            teacher.token,
          );
        },
      );
      await t.test(
        'messages and runs are idempotent and real Mastra executes tools and persists step costs',
        async () => {
          await assert.rejects(
            runs.send(su, conversation.id, {
              requestId: 'missing-revision',
              text: 'Explain',
              question: { resourceId: resource },
            }),
          );
          const sent = await runs.send(su, conversation.id, {
            requestId: 'same-request',
            text: 'USE_CALCULATOR',
          });
          assert.equal(
            (
              await runs.send(su, conversation.id, {
                requestId: 'same-request',
                text: 'USE_CALCULATOR',
              })
            ).runId,
            sent.runId,
          );
          await assert.rejects(
            runs.send(su, conversation.id, {
              requestId: 'another',
              text: 'busy',
            }),
          );
          await runs.execute(sent.runId);
          const result = await runs.events(su, sent.runId);
          assert.equal(result.run.status, 'completed', JSON.stringify(result));
          assert.ok(result.events.some((x) => x.type === 'tool-started'));
          assert.ok(result.events.some((x) => x.type === 'text-delta'));
          const tools = await c.rows('SELECT * FROM kl_tools WHERE run_id=?', [
            sent.runId,
          ]);
          assert.equal(c.json(tools[0].data).result.value, '4');
          const usage = await c.rows('SELECT * FROM kl_usage WHERE run_id=?', [
            sent.runId,
          ]);
          assert.ok(usage.length >= 2);
          assert.ok(usage.every((x) => x.user_id === su.id));
          assert.ok(
            usage.every(
              (x) => x.status === 'estimated' && Number(x.amount) > 0,
            ),
          );
          await runs.execute(sent.runId);
          assert.equal(
            (
              await c.rows('SELECT * FROM kl_usage WHERE run_id=?', [
                sent.runId,
              ])
            ).length,
            usage.length,
          );
        },
      );
      await t.test(
        'private documents are readable only by owner and agent teacher and never indexed publicly',
        async () => {
          const document = await docs.upload({
            user: su,
            bytes: Buffer.from(
              'Private student solution with distinctive_secret_string',
            ),
            name: 'homework.txt',
            conversationId: conversation.id,
          });
          for (let i = 0; i < 20; i++) {
            const d = await questions.detail(
              su,
              document.resourceId,
              document.revisionId,
            );
            if (d.status === 'ready') break;
            await new Promise((r) => setTimeout(r, 20));
          }
          await media.requireResource(tu, document.resourceId);
          await assert.rejects(media.requireResource(ot, document.resourceId));
          assert.equal(
            (await docs.search({ q: 'distinctive_secret_string' }, tu)).total,
            0,
          );
          const publicDoc = await docs.upload({
            user: tu,
            bytes: Buffer.from('Public calculus integration teaching notes'),
            name: 'notes.txt',
          });
          for (let i = 0; i < 20; i++) {
            if (
              (
                await questions.detail(
                  tu,
                  publicDoc.resourceId,
                  publicDoc.revisionId,
                )
              ).status === 'ready'
            )
              break;
            await new Promise((r) => setTimeout(r, 20));
          }
          assert.equal((await docs.search({ q: 'calculus' }, su)).total, 1);
          const replacement = await docs.replace(
            await media.requireResource(tu, publicDoc.resourceId),
            tu,
            Buffer.from('Updated differential teaching notes'),
            'notes.txt',
          );
          for (let i = 0; i < 20; i++) {
            if (
              (
                await questions.detail(
                  tu,
                  publicDoc.resourceId,
                  replacement.revisionId,
                )
              ).status === 'ready'
            )
              break;
            await new Promise((r) => setTimeout(r, 20));
          }
          assert.equal(
            (
              await questions.detail(
                tu,
                publicDoc.resourceId,
                publicDoc.revisionId,
              )
            ).chunks[0].body,
            'Public calculus integration teaching notes',
          );
        },
      );
      await t.test(
        'cancelled and interrupted runs release the conversation, and unpublished agents preserve history',
        async () => {
          const sent = await runs.send(su, conversation.id, {
            requestId: 'cancel-me',
            text: 'cancel',
          });
          await runs.cancel(su, sent.runId);
          await runs.execute(sent.runId);
          assert.equal(
            (await runs.events(su, sent.runId)).run.status,
            'cancelled',
          );
          const next = await runs.send(su, conversation.id, {
            requestId: 'interrupt-me',
            text: 'interrupt',
          });
          await c.rows("UPDATE kl_runs SET status='running' WHERE id=?", [
            next.runId,
          ]);
          await runs.recover();
          assert.equal(
            (await runs.events(su, next.runId)).run.status,
            'interrupted',
          );
          await api(
            'POST',
            `/api/ai/agents/${agent.id}/unpublish`,
            {},
            teacher.token,
          );
          await api(
            'POST',
            '/api/ai/conversations',
            { agentId: agent.id },
            student.token,
            404,
          );
          assert.equal(
            (await agents.getConversation(su, conversation.id)).id,
            conversation.id,
          );
        },
      );
      await t.test(
        'PDF, scanned PDF, DOCX and image attachments run through actual parsers',
        async () => {
          function pdf(text) {
            const objects = [
              '<< /Type /Catalog /Pages 2 0 R >>',
              '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
              '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
              '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
            ];
            const stream = text
              ? 'BT /F1 12 Tf 20 100 Td (' + text + ') Tj ET'
              : '';
            objects.push(
              '<< /Length ' +
                Buffer.byteLength(stream) +
                ' >>\nstream\n' +
                stream +
                '\nendstream',
            );
            let body = '%PDF-1.4\n',
              offsets = [0];
            objects.forEach((o, i) => {
              offsets.push(Buffer.byteLength(body));
              body += i + 1 + ' 0 obj\n' + o + '\nendobj\n';
            });
            const xref = Buffer.byteLength(body);
            body +=
              'xref\n0 6\n0000000000 65535 f \n' +
              offsets
                .slice(1)
                .map((x) => String(x).padStart(10, '0') + ' 00000 n \n')
                .join('') +
              'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' +
              xref +
              '\n%%EOF';
            return Buffer.from(body);
          }
          async function parsedChunks(bytes, extension, { user }) {
            const doc = await docs.upload({ user, bytes, name: 'fixture' + extension });
            for (let attempt = 0; attempt < 250; attempt++) {
              const detail = await questions.detail(user, doc.resourceId, doc.revisionId);
              if (detail.status === 'ready') return detail.chunks;
              if (detail.status === 'failed') assert.fail(detail.parseError);
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.fail('Timed out waiting for imported document');
          }
          const text = await parsedChunks(
            pdf('Public reading lesson with sufficient text for parsing.'),
            '.pdf',
            { user: tu, purpose: 'parse' },
          );
          assert.match(text[0].body, /Public reading/);
          const scanned = await parsedChunks(pdf(''), '.pdf', {
            user: tu,
            purpose: 'parse',
          });
          assert.ok(scanned[0].body.length > 0);
          const { ZipArchive } = require('archiver'),
            zip = new ZipArchive(),
            parts = [];
          zip.on('data', (d) => parts.push(d));
          const ended = new Promise((resolve, reject) => {
            zip.on('end', resolve);
            zip.on('error', reject);
          });
          zip.append(
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
            { name: '[Content_Types].xml' },
          );
          zip.append(
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
            { name: '_rels/.rels' },
          );
          zip.append(
            '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Student essay paragraph.</w:t></w:r></w:p></w:body></w:document>',
            { name: 'word/document.xml' },
          );
          await zip.finalize();
          await ended;
          const docx = await parsedChunks(Buffer.concat(parts), '.docx', {
            user: su,
            purpose: 'parse',
          });
          assert.match(docx[0].body, /Student essay/);
          const image = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1cAAAAASUVORK5CYII=',
            'base64',
          );
          const imageText = await parsedChunks(image, '.png', {
            user: su,
            purpose: 'parse',
          });
          assert.ok(imageText[0].body);
        },
      );
      await t.test(
        'actual 11-dataset sample imports, paginates and preserves every gallery role',
        async () => {
          const sampleRoot = path.resolve(__dirname, '../sample-data');
          if (
            !(await fs
              .access(path.join(sampleRoot, 'items.json'))
              .then(() => true)
              .catch(() => false))
          )
            return t.skip(
              'Prepare the independent sample with npm run sample before this data-specific check.',
            );
          const items = JSON.parse(
            await fs.readFile(path.join(sampleRoot, 'items.json'), 'utf8'),
          );
          assert.equal(new Set(items.map((x) => x.collection)).size, 11);
          const report = await questions.importQuestions({
            items,
            baseDirectory: sampleRoot,
            allowedRoot: sampleRoot,
          });
          assert.equal(report.created, items.length);
          assert.equal(report.missingMedia.length, 0);
          const current = await questions.list({ pageSize: 20 });
          assert.equal(current.items.length, 20);
          assert.equal(current.total, items.length + 2);
          const facets = await questions.facets();
          assert.ok(facets.some((x) => x.subjectLabel === '数学'));
          const roles = (
            await c.rows('SELECT DISTINCT kind FROM kl_media')
          ).map((x) => x.kind);
          for (const role of [
            'question',
            'source',
            'answer',
            'ms',
            'sm',
            'in',
            'si',
            'audio',
          ])
            assert.ok(roles.includes(role), role);
        },
      );
      await t.test(
        'formula rendering is authenticated and cancelled partial text remains in history',
        async () => {
          await agents.publish(tu, agent.id);
          const conv = await agents.conversation(su, agent.id);
          const sent = await runs.send(su, conv.id, {
            requestId: 'partial-cancel',
            text: 'show formula',
          });
          let started;
          const signal = new Promise((r) => {
            started = r;
          });
          const executing = runs.execute(sent.runId, async (input) => {
            await input.emit('text-delta', {
              text: 'Known partial answer $x^2$',
            });
            started();
            await new Promise((resolve) =>
              input.signal.addEventListener('abort', resolve, { once: true }),
            );
            return;
          });
          await signal;
          await runs.cancel(su, sent.runId);
          await executing;
          const messages = await c.rows(
            "SELECT * FROM kl_messages WHERE conversation_id=? AND role='assistant'",
            [conv.id],
          );
          assert.equal(messages.length, 1);
          assert.match(c.json(messages[0].data).text, /Known partial/);
        },
      );
      await t.test(
        'model configuration is optional for bank browsing and non-teachers have no admin or conversation access',
        async () => {
          const count = calls,
            oldBase = process.env.LITELLM_BASE_URL;
          delete process.env.LITELLM_BASE_URL;
          try {
            await api(
              'GET',
              '/api/question-bank/items?pageSize=2',
              null,
              student.token,
            );
            await api('GET', '/api/question-bank/facets', null, student.token);
          } finally {
            process.env.LITELLM_BASE_URL = oldBase;
          }
          assert.equal(calls, count);
          const platform = users[4];
          await api('GET', '/api/ai/admin/models', null, platform.token, 403);
          await api(
            'GET',
            '/api/ai/conversations/' + conversation.id,
            null,
            platform.token,
            403,
          );
        },
      );
      await t.test(
        'price changes preserve history, currencies stay separate and billing operations are idempotent',
        async () => {
          const billing = require('../src/learning/models'),
            old = await c.one(
              'SELECT * FROM kl_usage WHERE user_id=? AND amount IS NOT NULL LIMIT 1',
              [su.id],
            );
          const oldData = c.json(old.data);
          await billing.addPrice(model.id, {
            currency: 'CNY',
            rates: { input: '10', output: '20', cachedInput: '1' },
          });
          const pricing = await billing.price(model.id),
            context = { user: su, agentId: agent.id, purpose: 'student' };
          await billing.record(
            context,
            'test-price-operation',
            model.id,
            { input: 1000, output: 100, cached: 0 },
            pricing,
          );
          await billing.record(
            context,
            'test-price-operation',
            model.id,
            { input: 1000, output: 100, cached: 0 },
            pricing,
          );
          assert.equal(
            (
              await c.rows(
                "SELECT * FROM kl_usage WHERE operation_key='test-price-operation'",
              )
            ).length,
            1,
          );
          assert.equal(
            c.json(
              (await c.one('SELECT data FROM kl_usage WHERE id=?', [old.id]))
                .data,
            ).price.id,
            oldData.price.id,
          );
          const view = await billing.usage(su);
          assert.ok(view.summary.some((x) => x.currency === 'USD'));
          assert.ok(view.summary.some((x) => x.currency === 'CNY'));
        },
      );
      await t.test('library manager owns its chat and confirms real operations once', async () => {
        const manager = require('../src/learning/library-agent');
        async function applied(conversationId,id) {
          for(let attempt=0;attempt<100;attempt++) {
            const card=(await manager.cards(tu,conversationId)).find(x=>x.id===id);
            if(card.status==='applied') return card;
            if(card.status==='action_failed') throw Error(card.error);
            await new Promise(resolve=>setTimeout(resolve,10));
          }
          throw Error('Action did not finish');
        }
        const conv = await api('POST', '/api/ai/library-manager/conversation', {}, teacher.token);
        assert.equal((await manager.open(tu)).id, conv.id);
        await api('POST', '/api/ai/library-manager/conversation', {}, student.token, 403);
        assert.ok(!(await agents.list(tu, true)).items.some(x => x.name === '教学资料管家'));
        const run = await runs.send(tu, conv.id, { requestId: c.id(), text: '创建积分教学笔记' });
        await runs.execute(run.runId, async input => {
          assert.equal(input.libraryManagement, true);
          const proposal = await input.invoke('propose_library_change', { action: 'add_text', title: '管家测试笔记', text: '积分用于求原函数。' });
          assert.equal(proposal.awaitingConfirmation, true);
          await input.emit('text-delta', { text: '请确认资料操作。' });
        });
        const cards = await manager.cards(tu, conv.id);
        assert.equal(cards.length, 1);
        assert.equal((await docs.search({q:'管家测试笔记'},tu)).total, 0);
        await api('POST', '/api/ai/conversations/'+conv.id+'/library-actions/'+cards[0].id+'/confirm', {}, student.token, 403);
        await manager.confirm(tu, conv.id, cards[0].id);
        const first = await applied(conv.id, cards[0].id);
        const second = await manager.confirm(tu, conv.id, cards[0].id);
        assert.equal(first.outcome.resourceId, second.outcome.resourceId);
        const resource = await media.requireResource(tu, first.outcome.resourceId);
        assert.equal(resource.visibility, 'public');
        await assert.rejects(manager.propose({action:'withdraw',resourceId:resource.id,revisionId:'stale'},{user:tu,conversationId:conv.id}),/已更新/);
        await assert.rejects(manager.propose({action:'withdraw',resourceId:resource.id,revisionId:resource.current_revision},{user:su,conversationId:conv.id}),/教师权限/);
        await assert.rejects(manager.propose({action:'publish_attachment',attachmentId:resource.id,attachmentRevisionId:resource.current_revision},{user:tu,conversationId:conv.id}),/当前会话/);
        // A model change creates a new snapshot without losing the old conversation.
        const originalModel=(await modelsForManager()).builderModelId;
        async function modelsForManager(){return require('../src/learning/models').settings();}
        const nextModel=c.id();
        await c.rows('INSERT INTO kl_models(id,name,gateway_id,upstream_model,credential_ref,capabilities,parameters) SELECT ?,name,?,upstream_model,credential_ref,capabilities,parameters FROM kl_models WHERE id=?',[nextModel,'manager-switch-'+nextModel,originalModel]);
        await c.rows('UPDATE kl_settings SET data=? WHERE name=?',[JSON.stringify(nextModel),'builderModelId']);
        const switched=await manager.open(tu);
        assert.notEqual(switched.id,conv.id);
        assert.equal((await manager.open(tu)).id,switched.id);
        assert.equal((await agents.getConversation(tu,conv.id)).snapshot.model.id,originalModel);
        await c.rows('UPDATE kl_settings SET data=? WHERE name=?',[JSON.stringify(originalModel),'builderModelId']);
        // Concurrent parsing may finish in either order; only one revision may become current.
        const updates=await Promise.allSettled([
          docs.replace(resource,tu,Buffer.from('first update'),'first.txt',{expectedRevision:resource.current_revision,awaitReady:true}),
          docs.replace(resource,tu,Buffer.from('second update'),'second.txt',{expectedRevision:resource.current_revision,awaitReady:true}),
        ]);
        assert.equal(updates.filter(x=>x.status==='fulfilled').length,1);
        assert.equal(updates.filter(x=>x.status==='rejected'&&x.reason.status===409).length,1);
        resource.current_revision=(await media.requireResource(tu,resource.id)).current_revision;
        // The existing A-E files remain discoverable and indexable through this agent.
        await fs.mkdir(process.env.UPLOAD_ROOT,{recursive:true});
        await fs.writeFile(path.join(process.env.UPLOAD_ROOT,'manager-existing.txt'),'existing lesson content');
        const inserted=await c.rows('INSERT INTO files(category,original_name,stored_name,storage_path,file_type,mime_type,file_size,uploader_id) VALUES(?,?,?,?,?,?,?,?)',['A','manager-existing.txt','manager-existing.txt','manager-existing.txt','txt','text/plain',23,tu.id]);
        const found=await manager.searchFiles({query:'manager-existing',category:'A'},{user:tu,conversationId:conv.id});
        assert.equal(found.items[0].fileId,inserted.insertId);
        const importRun=await runs.send(tu,conv.id,{requestId:c.id(),text:'索引已有讲义'});
        await runs.execute(importRun.runId,async input=>{await input.invoke('propose_library_change',{action:'index_file',fileId:inserted.insertId});await input.emit('text-delta', { text: '请确认索引。' });});
        const importCard=(await manager.cards(tu,conv.id)).find(x=>x.status==='completed');
        await manager.confirm(tu,conv.id,importCard.id);
        const imported=await applied(conv.id,importCard.id);
        assert.equal((await media.requireResource(tu,imported.outcome.resourceId)).source_file_id,inserted.insertId);
        const withdrawal = await runs.send(tu, conv.id, { requestId: c.id(), text: '撤下刚才的测试笔记' });
        await runs.execute(withdrawal.runId, async input => {
          const result = await input.invoke('propose_library_change',{action:'withdraw',resourceId:resource.id,revisionId:resource.current_revision});
          assert.ok(['first.txt','second.txt'].includes(result.proposal.previousTitle));
          await input.emit('text-delta', { text: '请确认撤下。' });
        });
        const pending = (await manager.cards(tu,conv.id)).find(x=>x.status==='completed');
        await manager.confirm(tu,conv.id,pending.id);
        await applied(conv.id,pending.id);
        assert.equal((await c.one('SELECT visibility FROM kl_resources WHERE id=?',[resource.id])).visibility,'withdrawn');
        assert.ok((await agents.history(tu)).some(x=>x.id===conv.id && x.name==='教学资料管家'));
        const detail = await api('GET','/api/ai/conversations/'+conv.id,null,teacher.token);
        assert.equal(detail.libraryActions.filter(x=>x.status==='applied').length,3);
      });

      await require('./question-management.integration')({ t, api, origin, teacher, student, c });
      await t.test('previous clients can use A-E files and marks together with the drive', async () => {
        await api('GET', '/api/files/counts', null, null, 401);
        await api('GET', '/api/marks?category=A', null, null, 401);
        await api('GET', '/api/files?category=Z', null, student.token, 400);
        await api('GET', '/api/marks?category=Z', null, student.token, 400);
        const { folders } = await api('GET', '/api/drive/tree', null, teacher.token);
        const categoryA = folders.find(folder => folder.legacy_category === 'A');
        const categoryB = folders.find(folder => folder.legacy_category === 'B');
        const before = await api('GET', '/api/files/counts', null, student.token);
        assert.deepEqual(Object.keys(before), ['A', 'B', 'C', 'D', 'E']);

        const name = '旧版资料.bin';
        const form = new FormData();
        form.append('category', 'a');
        form.append('clientFileName', name);
        form.append('file', new Blob(['legacy bytes']), name);
        const upload = (token) => fetch(origin + '/api/files/upload', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form,
        });
        assert.equal((await upload(student.token)).status, 403);
        const uploaded = await upload(teacher.token);
        assert.equal(uploaded.status, 201, await uploaded.clone().text());
        const file = (await uploaded.json()).data;
        assert.equal(file.category, 'A');
        assert.equal(file.original_name, name);
        assert.equal(file.file_size, 12);
        const legacyPath = '/api/files/' + file.id;
        const firstItems = await api('GET', '/api/drive/items?folderId=' + categoryA.id, null, student.token);
        assert.ok(firstItems.files.some(item => item.id === file.id));
        assert.equal((await api('GET', '/api/files/counts', null, student.token)).A, before.A + 1);
        assert.deepEqual(await api('GET', legacyPath, null, student.token), file);
        assert.ok((await api('GET', '/api/files?category=A', null, student.token)).some(item => item.id === file.id));
        const response = await fetch(origin + legacyPath + '/download', {
          headers: { Authorization: 'Bearer ' + student.token },
        });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'legacy bytes');

        const zipResponse = await fetch(origin + '/api/files/export/A', {
          headers: { Authorization: 'Bearer ' + student.token },
        });
        assert.equal(zipResponse.status, 200);
        assert.match(zipResponse.headers.get('content-type'), /application\/zip/);
        const zip = await require('yauzl').fromBufferPromise(Buffer.from(await zipResponse.arrayBuffer()), { lazyEntries: true });
        const zipNames = [];
        await new Promise((resolve, reject) => {
          zip.on('error', reject);
          zip.on('end', resolve);
          zip.on('entry', entry => {
            zipNames.push(entry.fileName);
            zip.readEntry();
          });
          zip.readEntry();
        });
        assert.ok(zipNames.some(entry => entry.endsWith('_' + name)));

        await api('PUT', '/api/marks/' + file.id, null, student.token);
        assert.deepEqual((await api('GET', '/api/marks?category=A', null, student.token)).fileIds, [file.id]);
        assert.deepEqual((await api('GET', '/api/marks?category=A', null, otherStudent.token)).fileIds, []);
        await api('PATCH', '/api/drive/files/' + file.id, { folderId: categoryB.id }, teacher.token);
        assert.equal((await api('GET', legacyPath, null, student.token)).category, 'B');
        assert.deepEqual((await api('GET', '/api/marks?category=A', null, student.token)).fileIds, []);
        assert.deepEqual((await api('GET', '/api/marks?category=B', null, student.token)).fileIds, [file.id]);

        await api('PATCH', '/api/drive/files/' + file.id, { folderId: null }, teacher.token);
        await api('GET', legacyPath, null, student.token, 404);
        assert.equal((await api('GET', '/api/files/counts', null, student.token)).A, before.A);
        await api('PATCH', '/api/drive/files/' + file.id, { folderId: categoryB.id }, teacher.token);
        await api('DELETE', legacyPath, null, student.token, 403);
        assert.deepEqual(await api('DELETE', legacyPath, null, teacher.token), { message: '删除成功' });
        await api('GET', legacyPath, null, student.token, 404);
        assert.deepEqual((await api('GET', '/api/marks?category=B', null, student.token)).fileIds, []);
        const trash = await api('GET', '/api/drive/trash', null, teacher.token);
        assert.ok(trash.files.some(item => item.id === file.id));
        await api('POST', '/api/drive/trash/restore', { type: 'file', id: file.id }, teacher.token);
        assert.equal((await api('GET', legacyPath, null, student.token)).category, 'B');
      });
      await t.test('recycling a folder with an indexed file and restoring the file updates resource visibility', async () => {
        const folder = await api('POST', '/api/drive/folders', { name: 'Trash test' }, teacher.token, 201);
        const child = await api('POST', '/api/drive/folders', { name: 'Nested', parentId: folder.id }, teacher.token, 201);
        const resourceId = c.id();
        await c.rows("INSERT INTO kl_resources(id,namespace,source_id,type) VALUES(?,'drive-test',?,'document')", [resourceId, resourceId]);
        const file = await c.rows(
          'INSERT INTO files(category,folder_id,original_name,ai_resource_id,uploader_id) VALUES(?,?,?,?,?)',
          ['A', child.id, 'test.txt', resourceId, teacher.user.id],
        );
        const visibility = async () => (await c.one('SELECT visibility FROM kl_resources WHERE id=?', [resourceId])).visibility;
        await api('DELETE', '/api/drive/folders/' + folder.id, null, student.token, 403);
        const result = await api('DELETE', '/api/drive/folders/' + folder.id, null, teacher.token);
        assert.deepEqual(result.deletedFolderIds, [folder.id, child.id]);
        const trash = await api('GET', '/api/drive/trash', null, teacher.token);
        assert.ok(trash.folders.some(row => row.id === child.id));
        assert.ok(trash.files.some(row => row.id === file.insertId));
        assert.equal(await visibility(), 'withdrawn');
        await api('POST', '/api/drive/trash/restore', { type: 'file', id: file.insertId }, teacher.token);
        assert.equal(await visibility(), 'public');
        await api('DELETE', '/api/drive/files/' + file.insertId, null, teacher.token);
        assert.equal(await visibility(), 'withdrawn');
      });
      await t.test(
        'drive upload, marks and logout remain isolated and operational',
        async () => {
          const form = new FormData();
          form.append('clientFileName', 'notes.txt');
          form.append('file', new Blob(['abc']), 'notes.txt');
          const uploaded = await fetch(origin + '/api/drive/files/upload', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + teacher.token },
            body: form,
          });
          assert.equal(uploaded.status, 201);
          const uploadedFile = (await uploaded.json()).data;
          const download = await fetch(
            origin + '/api/drive/files/' + uploadedFile.id + '/download',
            { headers: { Authorization: 'Bearer ' + student.token } },
          );
          assert.equal(await download.text(), 'abc');
          await api(
            'DELETE',
            '/api/drive/files/' + uploadedFile.id,
            null,
            student.token,
            403,
          );
          const remember = await api(
            'POST',
            '/api/auth/login',
            {
              username: 'student2',
              password: 'test-password',
              rememberDevice: true,
            },
            null,
          );
          assert.ok(remember.rememberToken);
          const remembered = await api(
            'POST',
            '/api/auth/remember-login',
            { rememberToken: remember.rememberToken },
            null,
          );
          assert.equal(remembered.user.id, otherStudent.user.id);
          const indexed = await api(
            'POST',
            '/api/library/files/' + uploadedFile.id + '/index',
            {},
            teacher.token,
          );
          assert.ok(indexed.resourceId);
          const file = await c.one('SELECT id FROM files WHERE id=?', [uploadedFile.id]);
          await api('PUT', '/api/marks/' + file.id, {}, student.token);
          await api('DELETE', '/api/marks/' + file.id, null, student.token);
          await api('DELETE', '/api/drive/files/' + file.id, null, teacher.token);
          assert.equal(
            (
              await c.rows('SELECT * FROM user_file_marks WHERE file_id=?', [
                file.id,
              ])
            ).length,
            0,
          );
          await api('POST', '/api/auth/logout', {}, student.token);
          await api('GET', '/api/ai/agents', null, student.token, 401);
          if (signedMediaPath)
            assert.equal((await fetch(origin + signedMediaPath)).status, 401);
        },
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => gateway.close(resolve));
      await testPool.end();
      await connection.end();
    }
  },
);
after(async () => {
  const p = require('../src/db').pool;
  await p.end().catch(() => {});
});
