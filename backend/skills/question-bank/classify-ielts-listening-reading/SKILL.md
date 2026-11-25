---
name: classify-ielts-listening-reading
description: 当需要分类 Cambridge IELTS Academic 听力或阅读题组，或审核听读分类决策时使用。
---

# 分类 IELTS Academic 听力与阅读

## 适用范围

- 一条 item 对应共享同一指令、题型和版面结构的连续题组，不拆成逐小题；题型或指令变化时才切组。
- 听力只能使用 `L.*` 主题型，并且恰好一个 `scene:*`；禁止 `topic:*`。
- 阅读只能使用 `R.*` 主题型，并且恰好一个 `topic:*`；禁止 `scene:*`。
- `skill:*`、`book:*`、`test:*`、`section:*`、`passage:*` 是确定性结构标签，不由分类代理自由生成。

## 分类合同

读取完整指令、题图、题组文本、听力/阅读原文和答案，再读取 `references/taxonomy.json`。每个题组只能有一个 `primary_tag`。听力场景按整段交际目的判断；阅读主题按文章主旨判断，不能从个别名词或 section/passage 编号猜测。

### 听力场景边界

- `scene:daily_service`（日常服务）覆盖日常生活、社区公共事务与社会活动，包括市政和交通安排、员工或学徒入职说明、志愿服务、健身和跑步指导、野外生活建议、陶艺工坊体验、创业经验及商业展览介绍。
- `scene:travel`（旅行）包含以参观路线、设施位置和场所导览为目的的工厂参观或职业体验介绍。
- 一般岗前说明或兴趣活动介绍不因具有教学形式而归入学术课程；单人讲话不自动归入研究讲座。

## 判定流程

1. 先确定 skill，再只在该 skill 的主题型候选中判断。
2. 区分 T/F/NG 的事实判断与 Y/N/NG 的作者观点；区分 single/multiple choice 的选择数量；区分有词库与无词库填空。
3. 听力地图填空使用 `L.MAP_COMPLETION`，字母位置匹配使用 `L.MAP_ORIENTATION`；当前表单填空按 `L.NOTE_COMPLETION`。
4. 指令缺失、OCR 不完整、`scene:other`、`topic:other` 或置信度低于 0.8 时设置 `review_required=true`，状态不得伪装为已确认。

## 输出合同

```json
{"item_id":"ielts-15-test-02-listening-section-03-Q21-26","primary_tag":"L.INFORMATION_MATCHING","tags":["scene:group_discussion"],"confidence":0.91,"review_required":false,"reason":"题组要求将多位发言人与观点匹配，场景为学生小组讨论"}
```

合并发布记录时，最终 `tags` 必须包含 `primary_tag`、skill、book、test、section/passage 及唯一 scene/topic。决策文件必须一 item 一行、ID 无重复无遗漏、路径保持相对。

## 代理分工与验收

由**低成本 subagent**按 book/test/section 或 passage 的互不重叠批次初分；主代理维护 taxonomy，并复核 `other`、低置信度、题图依赖和边界异常。验收要求：每组恰好一个主题型、听力恰好一个 scene、阅读恰好一个 topic、`primary_tag in tags`（合并后）、结构标签完整、无跨 skill 标签。

## 常见错误

| 错误 | 正确处理 |
| --- | --- |
| 把连续题组拆成逐题 | 保持同指令题组一条 item |
| 混淆 T/F/NG 与 Y/N/NG | 判断事实还是作者观点 |
| 用 section 编号猜听力场景 | 阅读整段交际目的 |
| 听力加入 topic 或阅读加入 scene | 每个 skill 只保留自己的语义维度 |
