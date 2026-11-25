---
name: classify-cambridge-chinese-9868
description: 当需要分类 Cambridge 9868 中文试卷，或审核 9868 年份分类清单时使用。
---

# 分类 Cambridge 中文 9868

## 适用范围

- 当前发布模型是一条记录对应一整份试卷，不是单道题。
- 分类模式固定为 `year_only`；合法标签仅来自 `references/taxonomy.json`，当前为 `year:2024` 和 `year:2025`。
- session、paper、variant 和 specimen 是结构化元数据，不是 `primary_tag`。
- 在完成可靠切题、定义新 taxonomy 并获得明确批准前，不新增阅读、写作、文学、体裁或主题标签。

## 分类合同

年份必须从试卷封面和来源文件名交叉确认。`primary_tag` 必须等于 `year:{YYYY}`，并且 `tags` 必须只包含同一个年份标签。`details.classification` 固定为 `year_only`。年份未知或封面冲突时不得猜测，应进入复核队列。

## 判定流程

1. 确认 syllabus code 为 9868，并提取封面年份、session 和两位 paper 编号。
2. 用年份选择唯一合法标签；session 和 paper 只写入字段，不扩展 taxonomy。
3. 检查一条 item 是否仍代表完整试卷及其全部 gallery 页面，不能把页面误当成独立题目。
4. 年份证据冲突时设置 `review_required=true`、`quality_status="review_required"`，主标签暂不发布；证据一致时置信度可留空并使用 `quality_status="ready"`，保持现有发布合同。

## 输出合同

```json
{"id":"9868-2024-MJ-12","subject":"chinese","subject_label":"语文","collection":"chinese-9868","collection_label":"Cambridge 9868 中文","skill":"chinese-9868","skill_label":"中文","title":"9868 · 2024 年 · MJ · Paper 12","subtitle":"按年份整理","primary_tag":"year:2024","primary_tag_name":"2024 年","tags":["year:2024"],"tag_names":{"year:2024":"2024 年"},"classification_confidence":null,"review_required":false,"quality_status":"ready","image":"images/questions/9868-2024-MJ-12-P01.png","gallery":[],"audio":[],"question_range":null,"source_ref":{"question_document":"9868_s24_qp_12.pdf","related_documents":[]},"search_text":"9868 2024 MJ 12","details":{"syllabus_code":"9868","year":2024,"session":"MJ","paper":"12","classification":"year_only","is_specimen":false}}
```

`primary_tag`、`tags`、`details.year` 与顶层 `year` 必须一致。不要把 `paper=12` 解释成 12 年或新的题型代码。

## 代理分工与验收

由**低成本 subagent**按年份和文件批次核对封面元数据；主代理维护 taxonomy，并复核年份冲突、缺页和 specimen。验收要求：ID 唯一、年份字段一致、`primary_tag in tags`、每条记录恰好一个年份标签、gallery 页面存在、`details.classification="year_only"`。

## 常见错误

| 错误 | 正确处理 |
| --- | --- |
| 未切题就新增阅读/写作主题 | 保持 `year_only` |
| 把 session 或 paper 当主标签 | 仅作为元数据字段 |
| 从目录年份猜试卷年份 | 以封面和文件名交叉确认 |
| 把整卷页面拆成多个 item | 保持一份试卷一条记录 |
