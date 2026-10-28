# 完整应用开发与联调

本轮范围：题库、公共资料、教学 Agent、教师工作台、管理员模型管理与费用统计。开发使用独立代表性样本；题库分类继续在 Alevel 侧进行。样本题库服务通过后继续 Agent，实现不等待正式全量冻结。

## 已实现的入口

- 原资料首页 → **题库 · 教学助手**：题库筛选、分页、详情、答案、图片与音频。
- **公共教学资料**：上传 PDF/DOCX/图片、提交文字、索引已有 A–E 文件、查看解析状态、重试、上传新修订和撤下。
- **我的教学助手**：创建助手生成/修改草稿、公共材料引用、选择教学模型、试聊、发布与下架。
- **教学助手 / 会话历史**：文字、图片、PDF、DOCX、带题提问、逐步回答、工具进度、取消与恢复、公式和历史引用。
- **学生记录与费用**：教师自己的 Agent 下的完整学生会话及附件；个人、教师与平台费用分别授权。
- **平台管理**：LiteLLM 模型连接、密钥轮换、实际能力测试、默认创建/视觉模型、价格版本与平台费用。

## 服务和数据

Kelin 保留 Express/CommonJS、MySQL 与原认证。新增 Mastra 模块在 `backend/agent/` 编译为 ESM，由同一服务加载。业务数据使用 `kl_*` 表；迁移位于 `database/migrations/002_learning_platform.sql`，不改原文件与 marks 表关系。

LiteLLM 使用独立 PostgreSQL，单实例、单 worker。供应商密钥只发送至内部网关，Kelin 保存不含秘密的模型引用和版本快照。更换供应商模型新增配置，密钥轮换更新原连接。发布、试聊与会话保持原模型/指令快照。

网关模板见 [compose.yaml](../../deploy/litellm/compose.yaml)。`v1.106.0` 镜像已通过 GHCR manifest 查询确认，并固定 digest；Redis 不在首版部署范围。网关完整启动和真实供应商联调尚未执行。

价格以每百万 token 或每搜索 credit 配置，Kelin 每次操作固化价格。LiteLLM 的 token 成本字段按 USD 更新；其他币种仅在 Kelin 独立核算，不进行隐式汇率转换。未收到用量或价格时记录待核实，失败/取消仍保留已知费用。没有平台预算上限。

## 本地准备

1. Node.js 22.13+，以 22.23.2 验证。准备独立 MySQL 开发数据库；既有 Kelin 开发库直接复用。全新空库可先导入 `backend/test/fixtures/base.sql`，该文件是合成测试结构，不用于生产迁移。
2. 在 `backend` 执行 `npm ci`，复制 `.env.example` 为本地 `.env` 并配置数据库、学习存储和媒体签名。生产 `.env` 保持原内容并增补所需字段。
3. 执行 `npm run migrate`。迁移执行记录保存在 `kl_migrations`。
4. 抽取开发样本：

   ```powershell
   npm run sample -- --source D:/Projects/Alevel/output --out sample-data
   npm run import:questions -- --source sample-data --dry-run
   npm run import:questions -- --source sample-data
   ```

   抽样覆盖每个数据集前三条，并补齐媒体角色、质量状态、题组、多图和多音频。输出目录冻结后不覆盖，后续抽样使用新的 `--out`。媒体按哈希复制，分类源文件保持只读。输入校验使用应用侧 `questions.validate`，不依赖源库当前为 `null` 的 Schema。
5. 首位管理员使用现有账号登录后，显式执行 `npm run grant-admin -- --user-id ID`。权限保存在增量能力表，不改变 teacher/student 角色。
6. 按 `deploy/litellm/.env.example` 准备网关配置，执行 `docker compose --env-file .env -f compose.yaml up -d`。盐密钥需长期保留并备份。Kelin 配置内部网关地址、管理密钥与调用密钥；调用密钥不设费用预算。
7. `npm start` 自动构建 Agent 模块并启动现有服务。管理员添加模型，分别验证文字、工具和视觉能力，再设置创建助手/视觉默认模型与价格。
8. 在微信开发者工具控制台设置 `wx.setStorageSync('kelinDevBaseURL', 'https://测试环境域名')`，重新编译。该覆盖仅在开发版本读取；发布版本仍使用现有生产 API 地址。真机需配置可访问的 HTTPS 域名和微信服务器域名。

`BUILDER_MODEL_ID`、`VISION_MODEL_ID` 可以作为初始默认值；平台管理页面保存的配置优先。Tavily 使用服务器 `TAVILY_API_KEY`，配置后工具自动可用；搜索费用可通过服务项 `tavily` 配置。

## 接口和行为

- `/api/question-bank/items`：`q/subject/collection/skill/tag/reviewRequired/qualityStatus/releaseStatus/page/pageSize`。标签绑定 collection；每页默认 20、最大 100。详情 ID 为 `resourceId`，保留原始 `sourceId`。
- `/items/:id/revisions/:revisionId` 固定修订；媒体访问引用有效 15 分钟，读取时再次校验登录会话和资源权限，支持 Range。撤下或原文件已删除时返回不可用。
- `/api/library` 搜索公共可用修订。教师使用 `includeProcessing=true` 可查看自己未完成的资料。私有作业永不进入公共搜索。
- `/api/ai/agents`、`/:id/draft`、`/:id/builder-sessions`、`/:id/test-conversations`、`/:id/publish`、`/:id/unpublish` 提供完整创建发布流程。
- `/api/ai/conversations/:id/messages` 接收客户端 `requestId`、文字、当前会话附件 ID、明确的题目 ID/修订。持久化后立即返回消息和运行 ID；同一会话最多一个活动运行。
- `/api/ai/runs/:id/events?afterSequence=N&stream=1` 返回 NDJSON 增量事件；不支持 chunk 的客户端读取同一路由的 JSON 轮询响应。断连不重新触发模型；服务重启把活动运行标记为中断。历史消息每次读取最近 30 条，使用 `beforeSequence` 读取更早消息。
- `/api/ai/teacher/...` 校验 Agent 所有权；平台管理员默认只有运行及费用元数据权限，不获得所有会话正文。
- `/api/ai/admin/models`、`prices`、`settings`、`usage` 提供原生管理页面所需服务；普通客户端无法读取供应商密钥。

扫描页与图片通过默认视觉模型实际处理；PDF 保留页码，DOCX 保留段落。解析中的文件不伪装成已经读取。公共资料更新生成新修订，旧回答按原引用打开。

## 验证命令与实际结果

```powershell
npm run build
npm run check
$env:TEST_MYSQL_PORT='13307'
npm test
```

数据库测试连接本机独立测试 MySQL，以 `kelin_test_<pid>` 新建合成库，不连接生产。未提供 `TEST_MYSQL_PORT` 时集成测试显式跳过；首次实际数据测试前需准备 `sample-data`。不要把跳过记录当成通过。

原生本地编译：

```powershell
npm install --prefix .local/wechat miniprogram-ci@2.1.31 --registry=https://registry.npmjs.org
npm run check:mini
```

该命令不上传；SDK 构造使用临时本地密钥。当前本地编译成功生成 64 文件。云端应用属性查询提示缺少 access_token，因此未验证账号属性、上传或预览。桌面和真机运行仍待执行。

2026-10-28 开发验证记录见 [VALIDATION.md](VALIDATION.md)。自动化模型上游使用受控 HTTP 服务；实际运行 Mastra、解析器、数据库和 HTTP 权限，不能解释为已经联通付费供应商。

## 正式接入与回退

分类侧交付后，用同一导入器读取冻结的完整 `output`，保留清单和内容哈希，核验数量、媒体和查询性能。导入只 upsert 输入中的条目，不因样本缺席删除既有条目；内容或媒体变化产生修订。

部署前备份原后端、MySQL、LiteLLM PostgreSQL 和盐密钥；保留原 `.env` 与上传目录。先执行迁移及构建，再更新服务。Nginx 的运行事件路径使用 `proxy_buffering off`、`proxy_read_timeout 60s`；前端在 25 秒流连接结束后按 sequence 续读。

回退业务代码时保留新增表、学习媒体和网关数据；原文件/marks API 与新增表无反向依赖。不自动删除历史修订或撤销已知费用。生产部署、提交和推送不在本轮操作范围。
