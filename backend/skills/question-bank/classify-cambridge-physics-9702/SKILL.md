---
name: classify-cambridge-physics-9702
description: 当需要分类 Cambridge 9702 物理真题，或审核 9702 分类清单时使用。
---

# 分类 Cambridge 物理 9702

## 适用范围

- 只分类 Paper 1、Paper 2、Paper 4。
- Paper 3 和 Paper 5 在生成记录前直接排除，不生成实验技能、空标签或占位记录。
- Paper 1/2 在 2022 年及以后只允许主题 1–11；2019–2021 年试卷另允许主题 18（电场），按本项目统一 taxonomy 编号保存。Paper 4 允许主题 1–25。
- 年份依据：Cambridge [2019–2021 考纲](https://mes.govmu.org/mes/2020/pdf/9702_y19-21_sy.pdf) 第 9 页的 AS 内容包含 Electric fields；[2022–2024 考纲](https://www.cambridgeinternational.org/Images/554625-2022-2024-syllabus.pdf) 第 60 页说明该内容从 AS 移至 A Level。不得为满足新考纲范围而删除旧题实际考查的电场标签。
- 每个顶层大题只生成一条记录，必须包含全部 `(a)(b)(i)(ii)`，不得拆成小题。

## 分类合同

先完整阅读题干、图表和评分标准，再读取 `references/taxonomy.json`。关键词只能生成候选，不能直接决定标签。每题必须有一个 `primary_tag`，且该值必须同时出现在 `tags` 中；只有独立子问确实考查另一章节时才增加次标签。

## 判定流程

1. 找出获得主要分数所需的物理关系，题目背景名词不算证据。
2. 电荷、电流、电阻率和 I–V 特性归 9；电动势、内阻、基尔霍夫定律和分压器归 10；电场与电势归 18；电容充放电、储能和时间常数归 19。
3. 波的传播归 7，干涉、驻波和光栅归 8；温度测量归 14，气体分子模型归 15，热力学第一定律和过程推理归 16。
4. 无法确定时保留最佳候选、降低 `classification_confidence`，并设 `review_required=true`，不得猜测或拆题。

## 输出合同

```json
{"id":"9702-42-2025-MJ-Q03","subject":"物理","syllabus_code":"9702","year":2025,"session":"MJ","paper":42,"component":4,"question_number":3,"source_pdf":"data/物理/...pdf","tags":["19","10"],"primary_tag":"19","classification_confidence":0.92,"quality_status":"classified","review_required":false}
```

`paper` 保存两位试卷号，`component` 保存十位数字；Question Paper 42 必须写成 `paper=42, component=4`。`question_number` 使用整数，补零形式只出现在 `id`。

## 代理分工与验收

由**低成本 subagent**按互不重叠的年份、试卷或题号批量初分；主代理维护 taxonomy，并复核低置信度、多主题及边界题。验收要求：ID 唯一、component 只能为 1/2/4、标签非空、`primary_tag in tags`、所有代码存在于本 skill 的 taxonomy。

## 常见错误

| 错误 | 正确处理 |
| --- | --- |
| 为完整率分类 Paper 3/5 | 直接排除 |
| 从单个名词确定主题 | 依据得分方法和评分标准 |
| 把 D.C. circuits 合并进 Electricity | 电路定律使用主题 10 |
| 把 Q3(a)(b) 拆成多条 | 保持完整大题一条记录 |
