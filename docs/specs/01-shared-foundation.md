# 共用约定与现有基线

本文件维护两期共同使用的身份、资源修订、API 包装和 UI 规则。每期按自己的数据与验收规格实现，不提前建立另一阶段的业务模块。

## 既有系统与不可破坏的关系

- 复用原生 WXML/WXSS/JavaScript、Express、MySQL 和服务器文件存储。
- 同一 Kelin 后端入口和登录身份；继续使用 `requireAuth` 解析的 `users.id`。
- 保留 `/api/auth`、`/api/files`、`/api/marks` 及原教师/学生文件权限。
- 保留 `files.id` 和 marks 外键；个人 marks 始终按 `user_id + file_id` 隔离。
- 上传字节保留在服务器存储；新增数据库关系通过 `database/migrations/` 增量迁移。
- 生产 `.env`、上传文件、数据库 dump 和密钥不提交 Git。
- 部署前按现有交接要求备份后端与数据库，见 [agent.md](../../agent.md)。

## API 共用规则

- 普通 JSON 成功响应：`{ success: true, data: ... }`。
- 失败响应：`{ success: false, message: ... }`，可增加稳定错误码。
- 业务接口和媒体访问都需登录鉴权；列表分页。
- 对外传业务 ID、修订和受控媒体引用，不传服务器物理路径。
- 路由名称是实现约定；身份、资源范围和响应语义是联调契约。
- 第二期事件流使用独立事件编码，具体见 [Agent 运行时](phase-2-agent/01-authoring-and-runtime.md)。

## 资源身份与修订

`LibraryResource` 表示题目或既有文件的逻辑检索身份，`LibraryRevision` 表示一次不可变内容修订。这是逻辑契约，具体表名可以调整。

资源至少记录来源类型、来源命名空间、原始条目 ID、当前可读修订；修订记录内容哈希、来源版本、内容与媒体引用、定位信息及状态。

规则：

1. 保留原题目 ID 和 `files.id`，以来源命名空间区分不同来源。
2. 同一逻辑资源内容或标签变化形成新修订；当前指针只切换到准备完成的修订。
3. 读取指定修订时不能替换成最新内容；撤下或删除的原文明确显示不可用。
4. 媒体保持原来源位置或受控存储映射，不为题库、Agent 各复制一套独立文件库。
5. 第一期实现题目修订和读取契约；第二期把普通教学文档纳入同一资源体系，并增加回答 Citation。

第一期的字段映射和导入约束见[题库数据](phase-1-question-bank/01-data-and-api.md)；第二期公共资料的共享范围和回答引用见[资料与工具](phase-2-agent/02-public-library-and-tools.md)。

## 原生 UI 基线

沿用 [UI_REDESIGN.md](../UI_REDESIGN.md)：

- COLLINS Logo 与 `#9B1F58` 主色，暖白背景、深色正文、低对比边界。
- 衬线标题、系统无衬线正文，移动端卡片和适合桌面阅读的布局。
- 保留“归档 · 检索 · 标记”“熟能生巧。”和现有 A–E 浏览、搜索、marks。
- 新功能在现有原生小程序扩展，不嵌入原 Vue 应用或引入 CloudBase。
- 手机上传沿用拍照/相册、微信聊天文件等已有能力，不承诺任意系统文件浏览器。
- 第一期开通题库入口；第二期功能具备使用条件后再开放对应入口。

两期都需要开发者工具编译、桌面预览和真机验证。现有 `backend/npm test` 仅做 JavaScript 语法检查，不能替代接口、权限和 UI 验收。

## 已核查来源

| 来源 | 2026-10-20 检查基线 |
| --- | --- |
| Kelin | `5d94378e4c45783c5ada1fc8c79a72e8481f1bb1`；原生小程序、Express、MySQL、服务器文件存储 |
| Alevel 正式题库 | 9 个学科、11 个数据集、9,933 个唯一条目 ID；工作区存在内容修订 |
| question-bank-preview | `af060de489a4855f746bd9d9d592ce4f9dc06f50`；静态数据、客户端筛选、媒体 Worker |
| 参考 Agent 服务 | `b0446227a0600039cbbfca6c3b840c85d38126d5`；Mastra + AI SDK + AgentEngine；公共工具执行仍返回摘要 |

数量是检查时的样本基线，导入和页面统计必须读取实际清单与数据。未连接生产 MySQL、验证线上文件数量或核实生产 Node.js 版本。

### 证据入口

- Kelin：[认证](../../backend/src/middleware/auth.js)、[文件 API](../../backend/src/routes/files.js)、[文件名筛选](../../miniprogram/pages/home/home.js)。
- Alevel 正式数据：`output/question_bank_manifest.json`、`output/question_bank_database_v1/metadata/items.json`、`metadata/taxonomy.json`、`metadata/facets.json`。
- 预览站：[客户端查询](https://github.com/lagdads/question-bank-preview/blob/af060de489a4855f746bd9d9d592ce4f9dc06f50/src/question_bank_preview/app.js#L150)、[媒体 Worker](https://github.com/lagdads/question-bank-preview/blob/af060de489a4855f746bd9d9d592ce4f9dc06f50/worker/index.js#L52)。
- Agent：[摘要占位工具](https://github.com/lagdads/ai-skill-platform-demo/blob/b0446227a0600039cbbfca6c3b840c85d38126d5/apps/server/src/agent/mastra-agent-engine.ts#L137)。

Alevel 本次本地路径为 `D:/Projects/Alevel`，它不是生产程序的硬编码路径。旧 Alevel 平台中的 Vue 小程序、用户自带密钥、教师选择工具/题库、禁止创建助手生成 Skill、脚本执行等旧约束，不作为 Kelin 接入要求。

## 当前实现补充

Kelin 仍是唯一业务 API；新增 LiteLLM 内部网关与 PostgreSQL 专门管理供应商连接，业务身份和会话继续在 MySQL。运行环境、样本与验收状态以 [完整应用开发与联调](02-complete-implementation.md) 为准。
