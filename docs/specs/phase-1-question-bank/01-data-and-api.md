# 第一期：题库数据与 API

## 范围

把现有正式题库接入 Kelin 后端，供原生小程序查询、筛选和读取媒体。复用[共用约定](../01-shared-foundation.md)中的身份、资源修订和 API 包装。

本期数据来源为已整理的结构化题目；Kelin A–E 文件管理保持现状。普通教学文件的正文解析、公共文档搜索和 Agent 工具在第二期实现。

## 导入来源

| 输入 | 用途 |
| --- | --- |
| `output/question_bank_manifest.json` | 正式入口、数据集和发布信息 |
| `output/question_bank_database_v1/metadata/items.json` | 统一题目记录 |
| 同目录 `datasets.json`、`taxonomy.json`、`facets.json` | 数据集说明、标签与统计参考 |
| 各学科源包中的图片、答案材料和音频 | 保留媒体角色与来源 |

以正式统一数据为导入入口，预览站派生 catalog 不作为唯一权威来源。导入记录实际清单与内容哈希；媒体相对路径按正式库 README 解析，保留源文件或建立可追溯的受控存储映射。

检查时有 9,933 个唯一 ID。条目可能是单题、题组、整卷或听力材料，条目数不能直接解释为题目小问数或学生做题数。

## 字段契约

| 来源字段 | API 与页面用途 |
| --- | --- |
| `id` | 原始条目 ID |
| `subject` / `subject_label` | 学科 |
| `collection` / `collection_label` | 数据集及标签命名空间 |
| `skill` / `skill_label` | 已有听力、阅读等技能维度 |
| `title` / `subtitle` | 卡片和详情标题 |
| `primary_tag` / `primary_tag_name` / `tags` | 主标签和筛选 |
| `search_text` | 普通关键词查询 |
| `image` / `gallery` | 封面与关联图片 |
| `audio` | 音频引用数组 |
| `question_range` | 可选题号范围 |
| `source_ref` | 按数据集适配的来源定位 |
| `release_version` / `release_status` | 来源发布状态 |
| `review_required` / `quality_status` | 记录级质量状态 |

后端返回自己的 `resourceId`、`revisionId`、内容哈希及受控媒体引用，同时保留原始来源 ID。

标签键为 `(collection, tag code)`。同名代码不能跨数据集合并；标签查询使用 collection 作用域 taxonomy。学科、数据集、技能可以跨库汇总。

`details` 为源数据扩展字段。年份、考试季、试卷编号、难度和分值未统一，本期不假定所有条目都有这些筛选字段。`source_ref` 的 `document/pages`、`id/kind`、`file/pages` 等结构需按来源适配。

## 资源与媒体

本期实现题目版 `LibraryResource` / `LibraryRevision`。以 `(source_namespace, source_item_id)` 识别条目，以内容哈希识别修订；重复导入不重复建题，更新不覆盖旧修订。

| `gallery.kind` | 资源角色 |
| --- | --- |
| `question` | 题目 |
| `source` | 原文或关联题干材料 |
| `answer` | 答案 |
| `ms` / `sm` | 按数据集标注识别答案/样卷答案 |
| `in` / `si` | 插页/样卷插页 |
| 其他值 | 保留原 kind 与 label，不丢弃 |

题目未提供答案时返回实际缺失状态。音频是引用数组，检查时有 357 条记录非空；没有统一时长、转写或时间戳字段。

图片、音频和其他媒体均按修订关联并鉴权。原文不可访问时显式返回不可用，不能让旧修订地址转向新文件。

## 查询与 API

实现约定：先使用已有结构化字段和普通数据库查询，验证中文关键词、题号、标签和分页效果。搜索索引实现可调整，本期不增加语义搜索、以图搜题或推荐能力。

| 路由 | 契约 |
| --- | --- |
| `GET /api/question-bank/facets` | 学科、数据集、技能和数量，支持当前筛选上下文 |
| `GET /api/question-bank/taxonomy?collection=...` | 指定数据集的标签 |
| `GET /api/question-bank/items` | 关键词/学科/数据集/技能/标签/质量状态分页查询 |
| `GET /api/question-bank/items/:id` | 当前可用修订详情 |
| `GET /api/question-bank/items/:id/revisions/:revisionId` | 指定修订详情 |
| `GET /api/question-bank/items/:id/revisions/:revisionId/media/:mediaId` | 受控媒体或短期访问引用 |

列表返回轻量卡片、来源 ID 和 revisionId，详情返回关联材料。媒体输出不含服务器物理路径；查询数量来自实际导入结果和当前筛选，不一次下发整库。

后续 Agent 工具直接复用本期查询与读取服务，不解析静态站 HTML，也不建立另一套题目 ID。

## 导入前核验

- 核对实际记录数、唯一 ID、字段结构、媒体路径和质量状态。
- 保留 `review_required`、`provisional`、`unclassified_coding` 等实际状态，不能整体标记为已审核。
- 验证标签作用域、未知媒体 kind、无答案及异构来源记录。
- 2026-10-20 检查到 `schema/item.schema.json` 内容为 `null`。正式导入前必须修复或提供有效字段验证契约；本轮整理规格没有修改生成器。
- 数据工作区存在并行修订，导入以冻结后的清单和哈希为准。

验收与交付证据见[题库实施与验收](03-delivery-and-acceptance.md)。
