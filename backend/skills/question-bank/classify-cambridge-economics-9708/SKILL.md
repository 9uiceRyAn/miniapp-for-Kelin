---
name: classify-cambridge-economics-9708
description: 当需要分类 Cambridge 9708 经济真题，或审核 9708 分类清单时使用。
---

# 分类 Cambridge 经济 9708

## 适用范围

- 使用 11 个 Unit：AS 阶段 `AS.U1–AS.U6`，A2 阶段 `A2.U7–A2.U11`。
- Paper 1/2 只能使用 AS 标签；Paper 3/4 只能使用 A2 标签，禁止跨阶段贴标签。
- 每个完整顶层大题生成一条记录，不拆子问；题目、答案图片和记录保持一一对应。
- 同一题最多保留一个主标签和两个确有独立作答要求的次标签。

## 分类合同

完整阅读题干、材料、图表、全部子问和评分标准，再读取 `references/taxonomy.json`。`primary_tag` 表示承担主要分析链或最多分数的 Unit，并且必须位于 `tags` 中。题号位置和关键词只生成候选，不能替代经济机制判断。

## 判定流程

1. 先由 Paper 确定 AS/A2 阶段，再在同阶段 Unit 内比较候选。
2. 依据作答机制而不是背景词定主标签。例如外贸冲击若主要要求 AD/AS 分析，可将宏观 Unit 设为主标签，国际贸易 Unit 仅作次标签。
3. market failure、income distribution、policy、exchange rate 等跨 Unit 词必须结合命令词、图形和评分点消歧。
4. MCQ 题面过短、词法证据为空、前两候选接近或材料缺失时，降低 `classification_confidence` 并设 `review_required=true`；人工 override 可以推翻位置先验，但不得跨阶段。

## 输出合同

```json
{"id":"9708-22-2025-MJ-Q04","subject":"经济","syllabus_code":"9708","year":2025,"session":"MJ","paper":22,"component":2,"question_number":4,"source_pdf":"data/经济/...pdf","tags":["AS.U4","AS.U5"],"primary_tag":"AS.U4","classification_confidence":0.86,"quality_status":"classified","review_required":false,"details":{"stage":"AS"}}
```

状态必须一致：`review_required=true` 时使用 `quality_status="review_required"`。覆盖分类后要同步 `primary_tag_name`、`tag_names`、副标题和审核状态。

## 代理分工与验收

由**低成本 subagent**按阶段、试卷和互不重叠的题号批次初分；主代理维护 taxonomy，并复核低置信度、跨 Unit 和所有 override。验收要求：ID 唯一、`primary_tag in tags`、所有标签与 `details.stage` 一致、标签数不超过 3、题目与答案资产存在、分类名称字段同步。

## 常见错误

| 错误 | 正确处理 |
| --- | --- |
| 混用 AS 与 A2 同名概念 | 先按 Paper 锁定阶段 |
| 把题号位置先验当作真值 | 以经济机制和评分标准为准 |
| 看到外贸词就把国际 Unit 设为主标签 | 判断主要分析链 |
| 拆分结构化题的子问 | 保持完整顶层大题一条记录 |
