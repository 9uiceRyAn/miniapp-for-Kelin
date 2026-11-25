---
name: classify-cambridge-computer-science-9618
description: 当需要分类 Cambridge 9618 计算机科学真题，或审核 9618 分类清单时使用。
---

# 分类 Cambridge 计算机科学 9618

## 适用范围

- Paper 1 只允许主题 1–8；Paper 2 只允许 9–12；Paper 3 只允许 13–20。
- Paper 4 是完整代码提交的实操卷：保留真实大题记录，但标记为 `unclassified_coding`。
- 其他试卷中的纯代码编写或跟踪题，在确实难以可靠归类时也可使用 `unclassified_coding`。
- 每个顶层大题只生成一条记录，不拆 `(a)(b)(i)(ii)`。
- 误把伪代码行号或图中编号识别为题号时，按 `source_boundary_gap` 删除伪记录。

## 分类合同

先阅读完整题干、伪代码、图表和评分标准，再读取 `references/taxonomy.json`。关键词只生成候选。普通分类必须有一个 `primary_tag` 且位于 `tags` 中；coding 例外必须使用空 `tags`、空主标签和专用状态。

## 判定流程

1. 按试卷限定候选，再依据贡献主要分数的学习目标定主标签。
2. AS 与 A Level 同名主题必须分开：1/13 数据表示、2/14 通信、3/15 硬件、5/16 系统软件、6/17 安全、9/19 问题求解。
3. 数据类型、数组、文件和 ADT 归 10；AS 编程结构归 11；生命周期、设计和测试归 12；高级算法和递归归 19；编程范式、文件处理和异常归 20。
   结构图（structure chart）的构造与模块设计归 12.2，不得因为图中出现 procedure/function 而归 11；独立评分的例程头与参数传递归 11.3。按各子问真实得分分别计权。依据：[官方 9618 考纲，第 30 页](https://www.cambridgeinternational.org/Images/636089-2024-2025-syllabus.pdf)。
4. 无法可靠判断的 coding 题不追求填满标签，保留为有意未分类状态。

## 输出合同

普通记录使用标准字段。coding 例外示例：

```json
{"id":"9618-42-2025-MJ-Q01","subject":"计算机","syllabus_code":"9618","year":2025,"session":"MJ","paper":42,"component":4,"question_number":1,"source_pdf":"data/计算机/...pdf","tags":[],"primary_tag":null,"classification_confidence":null,"quality_status":"unclassified_coding","review_required":false,"review_reason":"practical coding component"}
```

Question Paper 32 必须写成 `paper=32, component=3`；`question_number` 使用整数。

## 代理分工与验收

由**低成本 subagent**按互不重叠的批次初分；主代理维护 taxonomy、复核低置信度和边界异常，并且不强求 coding 覆盖率。验收要求：ID 唯一、普通记录满足 `primary_tag in tags`、标签符合试卷候选范围、`unclassified_coding` 恰好为空标签与空主标签、伪边界记录已删除。

## 常见错误

| 错误 | 正确处理 |
| --- | --- |
| 强行给每个 Paper 4 大题填 19/20 | 使用 `unclassified_coding` |
| 把 A Level 内容折回 AS 标签 | 保留 13–20 |
| 把伪代码第 18 行当 Q18 | 删除伪记录 |
| 拆分代码和理论子问 | 保持完整大题一条记录 |
