---
name: build-math-question-database
description: 当 Codex 需要把 Cambridge International 9709 提纲、试卷和评分方案 PDF 转换为可移植的带标签题目数据库时使用，包括大题拆分、紧凑 PNG 渲染、主题分类、统一字段的 JSON/CSV 元数据，以及清除绝对路径和处理产物的交付包。
---

# 构建数学题目数据库

建立经过校验的双层题库：可续跑的工作题库和可移植发布包。在紧凑图片通过质量检查前，始终保留源题目内容。

## 前置条件

从项目根目录运行。在处理 PDF 前先定位工作区捆绑的依赖。需要：

- 安装了 `pdfplumber`、`Pillow`、`numpy` 的 Python；
- Poppler 命令 `pdfinfo`、`pdftoppm` 和 `pdftotext`；
- 9709 提纲 PDF 和试卷 PDF；强烈建议同时提供评分方案 PDF；

解析此 `SKILL.md` 所在目录，并赋给 shell 变量 `SKILL_DIR`。不要假定技能安装在某个机器专用路径。

使用 `scripts/math_question_bank.py` 提取题目并生成图片。只有工作题库校验通过后，才使用 `scripts/export_math_question_database.py`；它会在发布前调用 `scripts/audit_math_question_database.py`。

创建分类 JSONL 或修改数据库字段前，先阅读 [references/classification-and-schema.md](references/classification-and-schema.md)。

## 工作流程

### 1. 清点文件并建立题目边界

确定源目录并创建工作清单：

```bash
python3 "$SKILL_DIR/scripts/math_question_bank.py" build \
  --source "SOURCE_PDF_DIRECTORY" \
  --output output/math_question_bank
```

确认清点结果分别统计试卷和评分方案。文件名匹配必须忽略大小写，因为较新的试卷可能使用 `Question Paper`，而不是 `Question paper`。

检查 `metadata/extraction_diagnostics.json`，并目视检查题目数量异常的试卷。不要把封面页上的数字误认为第 1 题；脚本会选择最强的单调 `1..N` 序列，并支持显式的手动页码恢复。

试卷大题编号必须位于真正的左边距（支持的 9709 版式要求 `x0 <= 65` 点）。更靠右的数字属于正文、图形标签或系数。评分方案的题号栏需单独处理，可延伸到 `x0=95`。最后一题必须在标有 `Additional page` 或 `BLANK PAGE` 的页面前结束。

### 2. 分类每一道大题

对完整大题分类，包括所有 `(a)`、`(b)`、`(i)` 和 `(ii)` 小问。每条记录指定：

- 一个 `primary_tag`；
- 一个或多个主题 `tags`；
- 一个置信度；
- 分类不确定时设置 `review_required=true`。

按试卷组件限制候选标签。综合题目文字、图形和评分方案中的解法进行判断，不要只依据孤立关键词。综合题可以使用多个标签。

JSONL 每行写入一个 JSON 对象。按解析后的源 PDF 与题号合并，或按清单中的稳定 `id` 合并。最终分类不得保留空标签列表。

#### 分类委派与复核

默认将独立的批量分类工作委派给**低成本 subagent**执行。按试卷组件、年份或不重叠的题目 ID 划分任务，确保每条题目只由一个分类 subagent 写入初始结果。除非任务规模很小或用户明确要求主 agent 亲自分类，主 agent 不应自行逐题完成这类批量标注。

主 agent 负责：

- 从 syllabus 制定 taxonomy、字段契约与题目拆分边界；
- 为 subagent 提供受限的候选标签、题面/图表/评分方案证据要求和 `review_required` 规则；
- 汇总结果，检查覆盖率、重复 ID、空标签、标签前缀和置信度；
- 只复核低置信度、冲突、空匹配和涉及多主题的题目，并作出最终覆写。

分类 subagent 必须使用当前任务可胜任的最低成本模型；不得以省事为由跳过不确定标记，也不得为满足覆盖率而猜测标签。若平台不支持 subagent，则主 agent 按相同的分片与复核规则顺序执行，并在交付中说明这一例外。

### 3. 渲染、整理并压缩

应用分类并渲染源页面：

```bash
python3 "$SKILL_DIR/scripts/math_question_bank.py" organize \
  --output output/math_question_bank \
  --classifications work/classification_p1.jsonl work/classification_other.jsonl \
  --overrides work/classification_overrides.jsonl \
  --crop
```

将每一道大题合并为且仅为一张 PNG：

```bash
python3 "$SKILL_DIR/scripts/math_question_bank.py" stitch \
  --output output/math_question_bank
```

删除作答线和书写空白，同时保留全部题目内容：

```bash
python3 "$SKILL_DIR/scripts/math_question_bank.py" compact \
  --output output/math_question_bank
```

压缩过程必须把内容完整性置于外观整洁之前：

- 保留第一页的顶部边界；
- 对续页和页脚采用保守裁剪；
- 只折叠已验证的重复点状答题线；
- 保留公式、图形、表格、坐标图、题号、分值和所有小问；
- 在最终图片四周添加白色留边；
- 每张紧凑 PNG 都必须先暂存并校验，再提升为正式图片；
- 在 `original/questions` 中保留完整原图，以便回滚。

不要只根据像素密度裁剪条形码。密集的数学符号可能看起来像条形码，从而导致破坏性裁剪。

### 4. 校验工作题库

运行：

```bash
python3 "$SKILL_DIR/scripts/math_question_bank.py" validate \
  --output output/math_question_bank
```

必须满足：

- 每条清单记录都有标签；
- 每道题恰好有一张规范 PNG；
- 每个引用的 PNG 都存在；
- 不存在重复 ID；
- 标签目录链接到规范图片；
- 报告缺失的源评分方案，但这类缺口不应使题目图片失效。

目视抽查纯数学、力学、概率与统计的代表性样本，并至少检查一道多页公式题和一道图形或表格题。检查图片四条边是否有内容被裁掉。

### 5. 导出可移植数据库发布包

从项目根目录运行：

```bash
python3 "$SKILL_DIR/scripts/export_math_question_database.py"
```

导出器创建 `output/math_question_database_v1`，其中包含：

- `images/questions/` 中的紧凑 PNG；
- `by_tag/` 中的主题目录和索引；
- `metadata/questions.json`、`metadata/questions.csv` 和分类体系；
- JSON 与 CSV 使用完全相同的字段名和字段顺序；
- `schema/question.schema.json`；
- `release.json` 和中文交付说明。

导出器会先审计暂存发布包，再提升为正式发布包。发布包不得包含原图备份、临时渲染、裁剪计划、诊断数据、分类草稿或处理脚本。

### 6. 审计可移植性

运行可复用的发布包审计器：

```bash
python3 "$SKILL_DIR/scripts/audit_math_question_database.py" \
  output/math_question_database_v1
```

要求 `error_count=0`。审计器会逐字段比较 JSON 与 CSV，检查分类体系、标签索引和 PNG 文件；解码每张 PNG；强制执行试卷组件标签前缀；拒绝绝对路径、临时字段、数据库脚本和符号链接；并确认所有图片路径都相对于发布包根目录解析。

手动扫描所有可交付文本元数据，拒绝包含绝对工作区路径或中间字段的发布包：

```bash
rg -n '/Users/|Programming Project|tmp_render|compact_staging|crop_plan|bbox_points|question_pdf|mark_scheme_pdf|original/questions' \
  output/math_question_database_v1 \
  -g '*.json' -g '*.csv' -g '*.md'
```

把手动扫描作为自动审计后的第二道检查。确认每个已存图片路径都相对于发布包根目录，并能解析到实际文件。发布包不包含数据库脚本；下游系统自行使用 JSON 或 CSV 导入数据库。

## 安全规则

- 绝不覆盖源 PDF。
- 将工作输出与可移植发布包分开。
- 只有全部暂存校验通过后，才提升紧凑图片。
- 在用户接受紧凑版本前，保留完整题目原图。
- 宁可多保留条形码或空白，也不要裁掉数学内容。
- 把缺失的评分方案记录为源数据缺口，不要编造内容。
- 只发布相对路径；不得泄露工作区绝对路径。
- 只交付 JSON 和 CSV 题目元数据，不交付 SQL 或数据库文件。
