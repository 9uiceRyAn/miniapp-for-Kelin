# Kelin 题库与教学 Agent 规格

更新：2026-10-20。状态：产品决策已确认，功能待实现；当前优先交付小程序题库。

## 交付顺序

| 顺序 | 交付结果 | 完成依据 |
| --- | --- | --- |
| 第一期：题库 | 正式数据导入、查询 API、原生列表/详情/媒体；独立可用 | [题库实施与验收](phase-1-question-bank/03-delivery-and-acceptance.md) |
| 第二期：Agent | 创建助手、教学会话、带题提问、公共文档工具、教师记录与费用 | 第一期验收通过后，执行 [Agent 实施与验收](phase-2-agent/06-delivery-and-acceptance.md) |

第一期不依赖模型连接、Mastra 或 Agent 数据表；第二期复用已交付题库的身份、资源 ID、修订与读取服务。

## 从这里开始

题库开发按以下顺序阅读即可：

1. [产品决策](00-product-and-decisions.md)：分期范围及已确认行为。
2. [共用约定](01-shared-foundation.md)：现有业务、身份、资源版本和 UI 基线。
3. [题库数据与 API](phase-1-question-bank/01-data-and-api.md)。
4. [题库小程序页面](phase-1-question-bank/02-mini-program.md)。
5. [题库实施与验收](phase-1-question-bank/03-delivery-and-acceptance.md)。

第二期规格集中在 `phase-2-agent/`：

| 文档 | 权威范围 |
| --- | --- |
| [01-authoring-and-runtime.md](phase-2-agent/01-authoring-and-runtime.md) | 创建助手、Skill、版本、会话、运行事件 |
| [02-public-library-and-tools.md](phase-2-agent/02-public-library-and-tools.md) | 公共教学文档、平台工具、检索与回答引用 |
| [03-access-models-and-costs.md](phase-2-agent/03-access-models-and-costs.md) | Agent 权限、平台模型、费用监控 |
| [04-backend-and-api.md](phase-2-agent/04-backend-and-api.md) | Agent 模块合并、领域实体、API |
| [05-mini-program.md](phase-2-agent/05-mini-program.md) | 创建/教学/教师管理页面、带题提问 |
| [06-delivery-and-acceptance.md](phase-2-agent/06-delivery-and-acceptance.md) | 第二期顺序、接入条件、验收 |

## 维护规则

- 已确认产品行为统一记录在产品决策表 D01–D20；工程设计以“实现约定”标识。
- 共用规则只在共用约定维护；各期的数据、页面和验收各有归属，通过相对链接引用。
- 第一期验收使用 `QB-*`，第二期使用 `AG-*`。这些是待执行案例，不是测试通过记录。
- 记录当前代码事实时注明基线，不能把待实现设计描述为已有能力。
- Alevel 旧规格保留为独立平台历史方案；Kelin 接入以本目录为准。
- 遵守 [agent.md](../../agent.md) 中的既有业务、部署与资源约束。

完整应用开发与联调（题库 + Agent + LiteLLM）：[实施说明](02-complete-implementation.md)。样本题库通过后继续 Agent；正式全量验收在分类交付后执行。
