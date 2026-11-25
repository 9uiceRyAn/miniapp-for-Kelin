---
name: classify-cambridge-mathematics-9709
description: 当需要分类 Cambridge 9709 数学真题，或审核 9709 分类清单时使用。
---

# 分类 Cambridge 数学 9709

## 适用范围

- 分类 Paper 1–6，对应 Pure Mathematics 1/2/3、Mechanics、Probability & Statistics 1/2；完整主题范围为 `1.1–6.5`。
- 标签的组件前缀必须等于两位试卷号的十位：Paper 12 只能使用 `1.x`，Paper 62 只能使用 `6.x`。
- 每个完整大题只生成一条记录，不拆 `(a)(b)(i)(ii)`；保持题目、图片、ID 和页码一一对应。
- 只使用 `references/taxonomy.json` 中的 38 个 syllabus topic，不用“证明”“建模”等技巧标签替代主题。

## 分类合同

必须阅读完整题目、所有子问和评分标准。`primary_tag` 表示承担主要解题路径或最多关键分的方法，并且必须存在于 `tags` 中。只有某个章节是独立得分目标时才增加标签；常规代数整理、单位换算和背景知识不单独标记。

## 判定流程

1. 先按 Paper 限定候选代码，再判断每个子问的主要方法。
2. 同名主题仍按组件区分，例如 P2 Differentiation 使用 `2.4`，P3 使用 `3.4`，不得跨组件贴标签。
3. 综合题保留同一组件内的多个实质主题；主标签按主要分数与解题链确定，不按题面出现顺序。
   独立得分目标分值相同时，优先采用主要作答链的主题；仍无明显主次时沿用已有合理主标签，保留全部实质主题并记录并列依据。仅因分值并列不再保留分类待核。
4. OCR、图像或评分标准不完整，或主次主题无法稳定复现时，降低 `classification_confidence` 并设 `review_required=true`。

状态必须一致：`review_required=true` 时写 `quality_status="review_required"`；仅在无需复核时使用 `quality_status="classified"`。

## 输出合同

```json
{"id":"9709-11-2025-MJ-Q07","subject":"数学","syllabus_code":"9709","year":2025,"session":"MJ","paper":11,"component":1,"question_number":7,"source_pdf":"data/数学/...pdf","tags":["1.8","1.7"],"primary_tag":"1.8","classification_confidence":0.88,"quality_status":"classified","review_required":false}
```

`paper` 保存两位试卷号，`component` 保存十位数字，`question_number` 使用整数。`tags` 必须是数组，不能写成 CSV 中的 JSON 字符串。

## 代理分工与验收

由**低成本 subagent**按组件、年份或互不重叠的题号批次初分；主代理维护 taxonomy，并复核多主题、低置信度和图像依赖记录。验收要求：ID 唯一、标签非空、`primary_tag in tags`、组件前缀一致、每题一张规范图片、所有标签存在于官方 taxonomy。

## 常见错误

| 错误 | 正确处理 |
| --- | --- |
| 标记所有先备知识 | 只保留实质得分主题 |
| 混淆 P2/P3 同名章节 | 使用当前组件代码 |
| 只看题干不看评分标准 | 阅读全部子问和解法 |
| 拆子题但沿用原 Qxx ID | 保持完整大题一条记录 |
