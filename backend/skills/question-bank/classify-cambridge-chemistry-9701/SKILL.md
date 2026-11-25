---
name: classify-cambridge-chemistry-9701
description: 当需要分类 Cambridge 9701 化学真题，或审核 9701 分类清单时使用。
---

# 分类 Cambridge 化学 9701

## 适用范围

- 只分类 Paper 1、Paper 2、Paper 4。
- Paper 3 和 Paper 5 在生成记录前直接排除，不生成实验技能、空标签或占位记录。
- Paper 1/2 只允许主题 1–22；Paper 4 允许主题 1–37。
- 每个顶层大题生成一条记录，必须包含全部子问，不得按 `(a)(b)(i)(ii)` 拆分。

## 分类合同

先阅读完整题干、结构式、表格和评分标准，再读取 `references/taxonomy.json`。关键词仅用于缩小候选。每题必须有一个 `primary_tag`，并包含在 `tags` 中；次标签只用于真正独立考查的另一章节。

## 判定流程

1. 以获得主要分数所需的化学方法决定主标签，不按试卷号或单个试剂名称机械归类。
2. Hess 循环、键能和量热归 5；晶格能、Born–Haber、熵和 Gibbs 能归 23。基础氧化还原和电解归 6；标准电极电势与电池归 24。
3. `Kc` 与 Le Chatelier 原理归 7；`Ka`、`Kw`、缓冲液、滴定曲线和 `Ksp` 归 25。碰撞理论归 8；速率方程、级数和 Arrhenius 归 26。
4. 有机化学按评分标准要求的反应、机理或结构推断区分：AS 使用 13–22，A Level 扩展使用 29–37。仍不确定时降低置信度并设 `review_required=true`。
5. TLC 和气液色谱（包括组分比例、保留时间及固定相作用）归 37，不能归 AS 22；22 用于 AS 质谱与红外。依据 Cambridge 官方 [2025–2027 syllabus](https://www.cambridgeinternational.org/Images/664563-2025-2027-syllabus.pdf) 第 54 页 37.1–37.2；[2022–2024 syllabus](https://www.cambridgeinternational.org/Images/554616-2022-2024-syllabus.pdf) 第 48 页亦如此。酰氯、卤代烷与氯苯之间的相对水解难易比较明确列在 33.3.4，归 33；不能仅因出现氯苯就增加 30 或 31。硝腈水解制羧酸同时列于 18.1.1(b) 和 19.2.3，同一得分目标不应机械重复计权。

## 输出合同

```json
{"id":"9701-42-2025-MJ-Q03","subject":"化学","syllabus_code":"9701","year":2025,"session":"MJ","paper":42,"component":4,"question_number":3,"source_pdf":"data/化学/...pdf","tags":["24","6"],"primary_tag":"24","classification_confidence":0.93,"quality_status":"classified","review_required":false}
```

`paper` 保存两位试卷号，`component` 保存十位数字；Question Paper 42 写成 `paper=42, component=4`。`question_number` 使用整数。

## 代理分工与验收

由**低成本 subagent**按互不重叠的批次初分；主代理维护 taxonomy，并复核 AS/A Level 边界、多主题及低置信度题。验收要求：ID 唯一、component 只能为 1/2/4、标签非空、`primary_tag in tags`、Paper 1/2 不得使用 23–37、本 skill taxonomy 为唯一权威。

## 常见错误

| 错误 | 正确处理 |
| --- | --- |
| 给 Paper 3/5 建实验标签 | 直接排除 |
| Paper 4 的 energetics 全归 23 | 按实际方法区分 5 与 23 |
| 仅凭试剂名称分类 | 检查被评分的转化或机理 |
| 把合成题拆成多个小题记录 | 完整大题一条，多主题写入 `tags` |
