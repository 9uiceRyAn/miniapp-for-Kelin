import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
export interface EngineInput {
  model: { gateway_id: string; parameters: Record<string, unknown> };
  visionAvailable: boolean;
  libraryManagement?: boolean;
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
    apiKey: process.env.LITELLM_CALL_KEY || process.env.LITELLM_MASTER_KEY,
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
        query: z.string().optional(),
        subject: z.string().optional(),
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
  let text = '';
  for await (const chunk of stream.fullStream) {
    if (chunk.type === 'text-delta') {
      const delta =
        (chunk as any).payload?.text ??
        (chunk as any).payload?.textDelta ??
        (chunk as any).textDelta ??
        '';
      text += delta;
      await input.emit('text-delta', { text: delta });
    }
    if (chunk.type === 'error') throw new Error('模型执行失败');
  }
  return text;
}
