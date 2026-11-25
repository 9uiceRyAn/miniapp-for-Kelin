import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
export interface EngineInput {
  model: { gateway_id: string; parameters: Record<string, unknown> };
  visionAvailable: boolean;
  libraryManagement?: boolean;
  questionCurator?: boolean;
  instructions: string;
  messages: any[];
  signal: AbortSignal;
  invoke: (name: string, args: any) => Promise<any>;
  emit: (type: string, data: any) => Promise<void>;
  onStep: (step: any) => Promise<void>;
}
/** Runs one immutable conversation snapshot; the host owns storage and authorization. */
export async function execute(input: EngineInput) {
  const provider = createOpenAICompatible({
    name: 'litellm',
    baseURL: process.env.LITELLM_BASE_URL!.replace(/\/$/, '') + '/v1',
    apiKey: process.env.LITELLM_CALL_KEY,
  });
  const read = z.object({
    resourceId: z.string(),
    revisionId: z.string(),
    position: z.number().optional(),
    mediaId: z.string().optional(),
  });
  const definitions: Record<string, { description: string; schema: any }> = {
    search_questions: {
      description:
        '搜索真实公共题库，返回题目和修订 ID。标签查询须提供 collection。',
      schema: z.object({
        query: z.string().describe('题目编号或具体关键词；按科目浏览时省略，不要填写真实物理题等泛称。').optional(),
        subject: z.string().describe('英文科目代码，例如 physics、chemistry、biology、mathematics；不可填写中文科目名。').optional(),
        collection: z.string().optional(),
        tag: z.string().optional(),
      }),
    },
    search_library: {
      description: '搜索公共教学资料正文，返回修订和定位片段。',
      schema: z.object({ query: z.string() }),
    },
    read_library_resource: {
      description: '读取指定资料修订及页或段落，返回可引用的真实内容。',
      schema: read,
    },
    parse_file: {
      description: '读取当前会话已解析附件；解析状态失败时明确报告。',
      schema: read,
    },
    get_question_image: {
      description: '读取指定题目修订的题图或答案图并识别内容，保留材料角色。',
      schema: read,
    },
    read_image_text: {
      description: '识别获准访问的图片文字、公式与图表。',
      schema: read,
    },
    calculate: {
      description: '精确执行受限数学表达式，不支持脚本。',
      schema: z.object({ expression: z.string() }),
    },
  };
  if (input.libraryManagement) definitions.propose_library_change = {
    description: '准备公共教学资料操作卡片，教师点击确认后才执行。修改须填写真实目标资源及当前修订。发布或替换附件须填写本会话附件及修订。文字操作须提供完整标题和正文。',
    schema: z.object({
      action: z.enum(['add_text','publish_attachment','index_file','replace_text','replace_attachment','withdraw']),
      fileId: z.number().optional(),
      resourceId: z.string().optional(), revisionId: z.string().optional(),
      attachmentId: z.string().optional(), attachmentRevisionId: z.string().optional(),
      title: z.string().optional(), text: z.string().optional(),
    }),
  };
  if (input.libraryManagement) definitions.search_existing_files = {
    description: '查询原有 A–E 文件库，找到 fileId 后用 index_file 提案加入教学资料检索。不会上传或删除原文件。',
    schema: z.object({query:z.string().optional(),category:z.enum(['A','B','C','D','E']).optional(),page:z.number().optional()}),
  };
  if (input.questionCurator) {
    definitions.inspect_pdf_layout = {
      description: '分析会话中 PDF 附件各页的文字行坐标（归一化 0..1 纵向位置），用于定位每道大题的精确裁切边界。',
      schema: z.object({
        resourceId: z.string(),
        revisionId: z.string(),
        pages: z.array(z.number().int().min(1)).max(10).optional(),
      }),
    };
    definitions.crop_attachment_image = {
      description: '从会话 PDF 附件指定页码与归一化区域（top/bottom/left/right in 0..1）或图片附件裁切题目/答案图，跨页多区域自动纵向拼接为一张 PNG，返回可直接传给 create_question 的 attachment token。',
      schema: z.object({
        resourceId: z.string(),
        revisionId: z.string(),
        regions: z.array(z.object({
          page: z.number().int().min(1).optional(),
          top: z.number().min(0).max(1),
          bottom: z.number().min(0).max(1),
          left: z.number().min(0).max(1).optional(),
          right: z.number().min(0).max(1).optional(),
        })).min(1).max(6),
        kind: z.enum(['question', 'answer', 'ms', 'sm', 'source']).optional(),
        label: z.string().optional(),
        fileName: z.string().optional(),
      }),
    };
    definitions.read_question_skill = {
      description: '读取题库学科分类 Skill 与官方 taxonomy；不传 skillId 或传 list 时返回可用 Skill 列表。',
      schema: z.object({
        skillId: z.string().optional(),
        includeTaxonomy: z.boolean().optional(),
      }),
    };
    definitions.list_taxonomy = {
      description: '读取线上题库当前的学科、数据集和知识点标签树。',
      schema: z.object({}),
    };
    definitions.get_question_detail = {
      description: '根据 resourceId 获取题库中某道题目的完整详情与当前 revisionId。',
      schema: z.object({ resourceId: z.string() }),
    };
    definitions.create_question = {
      description: '直接录入一道新题到题库（立即生效）。录入前应先通过 read_question_skill 和 list_taxonomy 确认学科、数据集和标签。',
      schema: z.object({
        title: z.string(),
        subject: z.string(),
        subjectLabel: z.string().optional(),
        collection: z.string(),
        collectionLabel: z.string().optional(),
        sourceId: z.string().optional(),
        questionText: z.string().optional(),
        answerText: z.string().optional(),
        tags: z.array(z.string()).optional(),
        tagNames: z.record(z.string(), z.string()).optional(),
        attachments: z.array(z.object({
          token: z.string(),
          kind: z.enum(['question', 'answer', 'ms', 'sm', 'source']),
          label: z.string().optional(),
        })).optional(),
      }),
    };
    definitions.propose_question_update = {
      description: '提交修改已有题目的确认卡片，教师点击确认后才生效。须提供真实 resourceId 与 expectedRevisionId。',
      schema: z.object({
        resourceId: z.string(),
        expectedRevisionId: z.string(),
        title: z.string().optional(),
        questionText: z.string().optional(),
        answerText: z.string().optional(),
        tags: z.array(z.string()).optional(),
        tagNames: z.record(z.string(), z.string()).optional(),
        attachments: z.array(z.object({
          id: z.string().optional(),
          token: z.string().optional(),
          kind: z.enum(['question', 'answer', 'ms', 'sm', 'source']),
          label: z.string().optional(),
        })).optional(),
        summary: z.string().optional(),
      }),
    };
    definitions.propose_question_batch_update = {
      description: '提交批量修改已有题目的确认卡片（增删标签、删除或恢复），教师点击确认后才生效。',
      schema: z.object({
        ids: z.array(z.string()),
        action: z.enum(['add_tags', 'remove_tags', 'delete', 'restore']),
        tags: z.array(z.any()).optional(),
        summary: z.string().optional(),
      }),
    };
    definitions.propose_taxonomy_change = {
      description: '提交新增或更新学科、数据集、知识点标签的确认卡片，教师点击确认后才生效。',
      schema: z.object({
        operation: z.enum(['save_subject', 'save_collection', 'save_tag']).optional(),
        code: z.string(),
        label: z.string(),
        subjectCode: z.string().optional(),
        collectionCode: z.string().optional(),
        summary: z.string().optional(),
      }),
    };
  }
  if (process.env.TAVILY_API_KEY)
    definitions.web_search = {
      description: '搜索互联网，返回实际网页来源及引用键。',
      schema: z.object({ query: z.string() }),
    };
  if (!input.visionAvailable) {
    delete definitions.get_question_image;
    delete definitions.read_image_text;
  }
  const tools: Record<string, any> = {};
  for (const [name, def] of Object.entries(definitions))
    tools[name] = createTool({
      id: name,
      description: def.description,
      inputSchema: def.schema,
      execute: async (args: any) => input.invoke(name, args),
    });
  const agent = new Agent({
    id: 'kelin-runtime',
    name: '教学助手',
    instructions: input.instructions,
    model: provider.chatModel(input.model.gateway_id) as any,
    tools,
  });
  const stream = await agent.stream(input.messages, {
    abortSignal: input.signal,
    maxSteps: 12,
    maxRetries: 0,
    ...input.model.parameters,
    onStepFinish: input.onStep,
  } as any);
  for await (const chunk of stream.fullStream) {
    if (chunk.type === 'text-delta') {
      const delta =
        (chunk as any).payload?.text ??
        (chunk as any).payload?.textDelta ??
        (chunk as any).textDelta ??
        '';
      await input.emit('text-delta', { text: delta });
    }
    if (chunk.type === 'error') throw new Error('模型执行失败');
  }
}
