---
name: build-ielts-question-database
description: 将剑桥雅思 Academic 真题 PDF 转换为可移植的听力与阅读题库。用于统一文件名、识别 Test/Section/Passage、只按明确的大题作答说明拆分、生成跨页拼接 PNG、为每条记录内嵌完整 Reading Passage 或 Listening Audioscript、内嵌逐题答案、由 AI 设置唯一主标签和多个辅助标签，以及导出字段一致的 JSON/CSV 发布包并执行视觉与数据审计。不得用于 Writing、Speaking 或 General Training 题目入库。
---

# 构建雅思听力阅读题库

## 目标

把剑桥雅思真题整理成可直接使用的自包含发布包。每条记录对应一组受同一作答说明控制的连续题号，而不是机械地把每个题号切成一张图。每个题组必须具备：一张完整 PNG、一个主标签、多个辅助标签、完整原文（Reading Passage 或 Listening Section Audioscript），以及题号范围内每一道题的答案。

只处理 Academic Listening 与 Academic Reading。Writing、Speaking、General Training、写作范文和口语示例一律作为边界信息，不进入本发布包。

## 执行原则

1. 先清点源 PDF，验证卷号、页数、文件哈希和命名映射；不覆盖或重编码源文件。
2. 优先使用 PDF 文本层，扫描页或文本层损坏时再使用 OCR。
3. 题目图片以 PDF 页面为视觉权威；OCR 只用于定位、检索和辅助分类。
4. 裁剪时保留上下安全白边。跨页题组纵向拼接成一张 PNG，不能漏掉题干、小问、选项、表格、地图或流程图。
5. 处理中可复用独立的 Passage/Audioscript 来源记录，但交付时每条 item 必须内嵌完整 `source_text` 和 `source_images`，不能要求使用者再做表连接。
6. 答案按 `item_id + question_number` 关联，不允许只凭卷号或 Test 模糊关联。
7. 分类必须由具备题目与原文上下文的 AI 执行；规则只能生成候选标签或发现明显冲突，不能冒充最终语义分类。
8. 每个题组恰好一个 `primary_tag`，并把它同时放入 `tags`；其余标签描述技能、场景或题材、卷号、Test、Section/Passage。
9. 所有发布路径使用相对于发布根目录的 POSIX 路径，不得包含绝对路径、临时目录、OCR 缓存或处理步骤字段。
10. 完成前必须同时通过数据审计和 AI 视觉抽检。

## 标准流程

### 一、建立源文件清单

运行 `scripts/ielts_catalog.py`，为每卷建立页清单和源文件 manifest。剑8–10 可能同时包含 General Training，解析时只能选 Academic Listening/Reading。

### 二、识别题目并只按大题拆分

运行 `scripts/ielts_question_bank.py`。把同一作答说明控制的连续题号保存为一个 item，例如 Questions 1–5 共用一条说明时生成一个 `Q01-05` 题组。Reading 一篇 Passage 通常包含 2–4 个明确的大题块，只能在新的 `Questions x-y` 作答说明处拆分；不能按单个小题、分页或图片高度继续拆。Listening 在每个 Section 内按明确题型块拆分。检查每卷每个 Test 的 Listening 1–40 和 Reading 1–40 是否完整且无重叠。

### 三、提取原文

运行 `scripts/ielts_source_texts.py`。阅读每个 Passage 保存完整原文；听力每个 Section 保存对应 Audioscript。原文记录必须带卷号、Test、技能、单元号、页码范围和稳定 ID。

### 四、提取并关联答案

运行 `scripts/ielts_answers.py`。答案按题号拆成结构化记录，再直接链接到覆盖该题号的 item。保留原书答案页 PNG；多个可接受答案分别写入 `answer_text` 与 `accepted_variants`。OCR 不确定项必须查看答案页原图后修正，不能凭语言常识猜测。

### 五、渲染题目与原文 PNG

运行 `scripts/ielts_png_renderer.py`。每个 item 只生成一张规范 PNG；跨页时拼接。原文可包含多张按页排序的 PNG。渲染后检查图片可解码、四边为安全白边、题干与最后一个小问均完整。

若 AI 逐张验收确认某些末题仍带有源 PDF 的导航页脚，运行 `scripts/ielts_item_visual_refinements.py` 并使用 `scripts/ielts_item_visual_overrides.json`。精修只能采用已逐张确认的 `crop_bottom`，裁剪后必须重新加入安全白边并再次查看完整题干、最后一问和表格/边框；不得用该步骤掩盖未检查的自动裁剪错误。

随后运行 `scripts/ielts_prompt_text.py` 清理 `prompt_text`。正常题组沿用并清理 PDF/OCR 文本；若文本异常过长，说明可能混入后续 Passage 或其他页面，脚本会以最终裁剪 PNG 的 OCR 文本替换。该步骤必须在最终渲染之后执行，确保文字与交付图片对应。

### 六、由 AI 分类

先用 `scripts/ielts_taxonomy.py` 读取标签词表，再由 AI 结合题目图片、题目文字和对应原文确定分类，最后用 `scripts/ielts_classification.py` 写回结果。听力主标签以 `L.` 开头，阅读主标签以 `R.` 开头。低置信度、OCR 合并异常或 `scene/topic:other` 必须设置 `review_required=true`。

### 七、导出 JSON/CSV 自包含发布包

先运行 `scripts/assemble_ielts_release_inputs.py` 聚合各卷的题组、原文和答案，应用 AI 分类结果，并生成只含稳定字段的发布输入。对已确认的误拆、漏拆和串页运行 `scripts/repair_ielts_large_question_boundaries.py`。随后运行 `scripts/export_ielts_question_database.py`，只生成 JSON、CSV、schema、标签索引和 PNG 资产。

`metadata/items.json` 与 `metadata/items.csv` 必须使用完全相同的字段和顺序。每条记录内嵌 `source_text`、`source_images`、`answers`；CSV 的数组和对象使用 JSON 字符串。不得交付 SQL、JSONL 或需要额外连接的来源/答案表。详细契约见 [数据库与验收契约](references/数据库与验收契约.md)。

### 八、最终审计

运行 `scripts/audit_ielts_question_database.py`。只有 `error_count=0` 才能交付。审计后再由 AI 每卷抽检题目 PNG，并覆盖地图、表格、流程图、跨页题组、阅读原文、Audioscript 和答案页；把结果写入 `metadata/visual_qa.json`。

## 必须验证的数量关系

- item ID、source text ID 和 answer ID 各自唯一。
- 每个 item 恰好一张题目 PNG、恰好一个主标签、至少一个辅助标签。
- 每个 item 的 `source_text_id` 存在且卷号、Test、技能一致。
- 题组范围内每个题号恰好有一条结构化答案。
- 每卷每个 Academic Test 的 Listening 和 Reading 题号均覆盖 1–40，且无空缺、无重叠。
- JSON 与 CSV 字段、顺序和解析后的内容完全一致。
- 每条 item 单独读取时即可获得完整大题、完整原文和范围内全部答案。
- 发布包不包含 Writing、Speaking、General Training 项目或标签。
- 发布包全文不包含 `/Users/`、`file://`、Windows 盘符或工作区名称。

## 异常处理

- 找不到题组标题：保守扩大裁剪范围并标记视觉复核，不得缩小到可能截断内容。
- 题组跨页：拼接所需页面，确认中间没有漏页或重复下一题。
- 原文或答案 OCR 失真：查看原始页面 PNG，记录人工/AI 视觉修正来源。
- 无法可靠分类：选择最符合题型定义的主标签，降低置信度并标记复核；不得添加第二个主标签。
- 审计失败：修复上游记录并重新导出，不能直接修改交付文件掩盖上游问题。

## 交付内容

交付发布目录以及本 Skill。发布目录至少包含中文 `README.md`、`release.json`、`metadata/items.json`、`metadata/items.csv`、`metadata/taxonomy.json`、`schema/`、`images/items/`、`images/source_texts/`、`images/answers/` 和 `by_tag/`。不得包含 `database/`、SQL、JSONL、OCR 缓存、临时渲染页、调试日志或源文件绝对路径。
