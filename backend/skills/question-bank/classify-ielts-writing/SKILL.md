---
name: classify-ielts-writing
description: 当需要分类 IELTS Writing Task 1 或 Task 2 题目，或审核写作分类记录时使用。
---

# 分类 IELTS Writing

## 适用范围

- 一条 item 对应一道完整写作题，题干、题图、范文图、来源页码和分类字段保持一一对应。
- Task 1 只能使用四类：`T1.DYNAMIC_TREND`、`T1.STATIC_DATA`、`T1.PROCESS`、`T1.MAP`，并且只能有一个标签。
- Task 2 只能使用八个主题 `T2.*`，允许一个主标签和最多两个真正独立的次主题。
- 同意与否、讨论双方、利弊、原因解决等写作题型不是主题标签。

## 分类合同

完整阅读题干和题图，再读取 `references/taxonomy.json`。`primary_tag` 表示题目要求考生主要描述或论证的对象，并且必须位于 `tags` 中。Task 1 依据图表结构；Task 2 依据核心社会议题，不按某个高频词机械分类。

## 判定流程

1. Task 1 使用优先级：地图/场地变化归 `T1.MAP`；生产、循环和步骤归 `T1.PROCESS`；存在明确时间轴或趋势归 `T1.DYNAMIC_TREND`；其余单时点比较归 `T1.STATIC_DATA`。
2. Task 2 在教育、环境、科技、政府、城市化、全球化、媒体、社会八类中选择主要论证轴。
3. 政府作为实施手段时不自动归 `T2.GOVERNMENT`；例如政府投资交通通常以 `T2.URBANIZATION` 为主。只有公共职责、财政、法律或监管本身是讨论中心时才以政府为主。
4. OCR 缺字、图像不可辨、最高候选接近、Task 2 无有效主题证据或 Task 1 题干过短时，降低 `classification_confidence`，设置 `review_required=true` 和 `quality_status="review_required"`。

## 输出合同

```json
{"id":"IELTS-W-T2-Q108","task":2,"source_order":108,"prompt_text":"Governments should regulate online advertising aimed at children.","question_image":"images/questions/IELTS-W-T2-Q108.png","answer_image":"images/answers/IELTS-W-T2-Q108.png","primary_tag":"T2.MEDIA","tags":["T2.MEDIA","T2.GOVERNMENT"],"classification_confidence":0.86,"review_required":false,"quality_status":"ready","tag_names":{"T2.MEDIA":"媒体","T2.GOVERNMENT":"政府"}}
```

Task 1 的 `tags` 必须是仅含 `primary_tag` 的单元素数组。Task 2 标签总数不得超过 3，且主标签放在首位。

## 代理分工与验收

由**低成本 subagent**按 Task 和互不重叠的题号批次初分；主代理维护 taxonomy，并复核多主题、低置信度、OCR 和图像依赖记录。验收要求：Task 与标签前缀一致、`primary_tag in tags`、Task 1 单标签、Task 2 不超过三标签、状态字段一致、题目与答案图片存在。

## 常见错误

| 错误 | 正确处理 |
| --- | --- |
| 两个年份的图表仍归静态数据 | 有时间变化时归动态趋势 |
| 地图中出现年份就归动态趋势 | 地图优先使用 `T1.MAP` |
| 把“同意与否”当主题 | 题型不进入 taxonomy |
| 看到 government 就归政府 | 判断政府是手段还是核心议题 |
