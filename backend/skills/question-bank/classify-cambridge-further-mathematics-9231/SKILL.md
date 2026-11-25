---
name: classify-cambridge-further-mathematics-9231
description: 当需要分类 Cambridge 9231 进阶数学真题，或审核 9231 分类清单时使用。
---

# 分类 Cambridge 进阶数学 9231

## 适用范围

- 分类 Paper 1–4。
- Paper 1 只允许 `1.1–1.7`；Paper 2 只允许 `2.1–2.6`；Paper 3 只允许 `3.1–3.6`；Paper 4 只允许 `4.1–4.5`。
- 标签的组件前缀必须等于两位试卷号的十位：Question Paper 31 只能使用 `3.x`。
- 每个完整大题只生成一条记录，不拆 `(a)(b)(i)(ii)`。
- 不使用粗标签 `1/2/3/4`，也不新增第二套 `syllabus_topics` 字段；`tags` 是唯一主题分类。

## 分类合同

完整阅读题目和评分标准中的解法，再读取 `references/taxonomy.json`。关键词只生成候选。`primary_tag` 由承担主要分数的方法决定，并且必须包含在 `tags` 中；普通代数、微积分或 9709 先修知识不另加标签。

## 判定流程

1. 先按 Paper 限定候选，再判断核心数学方法；这可区分 Paper 1 矩阵 `1.4` 与 Paper 2 矩阵 `2.2`。
2. 变力微分建模、功–能和位置相关运动归 `3.5`；碰撞、冲量和动量守恒归 `3.6`。
3. normal/t 置信区间与检验归 `4.2`；卡方检验归 `4.3`；秩检验和符号检验归 `4.4`；概率母函数归 `4.5`。
4. 两种方法竞争或题面记号缺失时，保留候选、降低置信度并设 `review_required=true`，不得退回组件粗标签。

## 输出合同

```json
{"id":"9231-31-2025-MJ-Q04","subject":"进阶数学","syllabus_code":"9231","year":2025,"session":"MJ","paper":31,"component":3,"question_number":4,"source_pdf":"data/进阶数学/...pdf","tags":["3.3"],"primary_tag":"3.3","classification_confidence":0.93,"quality_status":"classified","review_required":false}
```

`paper` 保存两位试卷号，`component` 保存十位数字，`question_number` 使用整数。

## 代理分工与验收

由**低成本 subagent**按互不重叠的批次初分；主代理维护 taxonomy，并复核多主题、记号依赖和低置信度记录。验收要求：ID 唯一、标签非空、`primary_tag in tags`、组件前缀正确、标签存在于官方 taxonomy、每个完整大题恰好一条记录。

## 常见错误

| 错误 | 正确处理 |
| --- | --- |
| 用 component 3 作为标签 `3` | 选择 `3.1–3.6` |
| 增加第二套主题字段 | 只使用 `tags` |
| 标记先修微积分 | 标记真正被考查的 9231 方法 |
| 拆分多部分题 | 保持完整大题一条记录 |
