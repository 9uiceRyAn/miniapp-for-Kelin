# 分类与数据库契约

## 目录

1. 分类记录
2. 主题分类体系
3. 稳定标识符
4. 可移植发布记录
5. JSON 与 CSV 字段
6. 质量检查

## 1. 分类记录

使用 UTF-8 JSONL，每行写入一道大题：

```json
{
  "source_pdf": "relative/path/to/question-paper.pdf",
  "year": 2024,
  "session": "ON",
  "paper": 12,
  "question_number": 7,
  "primary_tag": "1.8",
  "tags": ["1.8", "1.1"],
  "confidence": 0.96,
  "review_required": false
}
```

覆盖记录可以使用稳定 `id`，代替 `source_pdf` 和 `question_number`：

```json
{"id":"9709-12-2024-ON-Q07","primary_tag":"1.8","tags":["1.8","1.1"],"confidence":0.96,"review_required":false}
```

规范值必须使用代码。导出发布包时再规范化面向用户的名称。

每个标签的第一位数字必须与试卷号的第一位数字一致。例如，Paper 62 只能使用 `6.x` 标签。跨组件分类必须判定为校验失败，手动覆盖也不例外。

## 2. 主题分类体系

分类文档采用“中文名称（英文原值）”格式；代码和导出元数据中的英文规范值保持不变。

### 试卷 1——纯数学 1（Pure Mathematics 1）

- `1.1` 二次方程（Quadratics）
- `1.2` 函数（Functions）
- `1.3` 坐标几何（Coordinate geometry）
- `1.4` 弧度制（Circular measure）
- `1.5` 三角学（Trigonometry）
- `1.6` 数列（Series）
- `1.7` 微分（Differentiation）
- `1.8` 积分（Integration）

### 试卷 2——纯数学 2（Pure Mathematics 2）

- `2.1` 代数（Algebra）
- `2.2` 对数函数与指数函数（Logarithmic and exponential functions）
- `2.3` 三角学（Trigonometry）
- `2.4` 微分（Differentiation）
- `2.5` 积分（Integration）
- `2.6` 方程的数值解（Numerical solution of equations）

### 试卷 3——纯数学 3（Pure Mathematics 3）

- `3.1` 代数（Algebra）
- `3.2` 对数函数与指数函数（Logarithmic and exponential functions）
- `3.3` 三角学（Trigonometry）
- `3.4` 微分（Differentiation）
- `3.5` 积分（Integration）
- `3.6` 方程的数值解（Numerical solution of equations）
- `3.7` 向量（Vectors）
- `3.8` 微分方程（Differential equations）
- `3.9` 复数（Complex numbers）

### 试卷 4——力学（Mechanics）

- `4.1` 力与平衡（Forces and equilibrium）
- `4.2` 直线运动学（Kinematics of motion in a straight line）
- `4.3` 动量（Momentum）
- `4.4` 牛顿运动定律（Newton's laws of motion）
- `4.5` 能量、功与功率（Energy, work and power）

### 试卷 5——概率与统计 1（Probability and Statistics 1）

- `5.1` 数据表示（Representation of data）
- `5.2` 排列与组合（Permutations and combinations）
- `5.3` 概率（Probability）
- `5.4` 离散随机变量（Discrete random variables）
- `5.5` 正态分布（The normal distribution）

### 试卷 6——概率与统计 2（Probability and Statistics 2）

- `6.1` 泊松分布（The Poisson distribution）
- `6.2` 随机变量的线性组合（Linear combinations of random variables）
- `6.3` 连续随机变量（Continuous random variables）
- `6.4` 抽样与估计（Sampling and estimation）
- `6.5` 假设检验（Hypothesis tests）

## 3. 稳定标识符

使用：

```text
9709-{paper}-{year}-{session}-Q{two-digit-question-number}
```

示例：

- `9709-12-2024-ON-Q07`
- `9709-42-2023-MJ-Q03`

考季代码为 `FM`、`MJ` 和 `ON`。这些代码及稳定 ID 格式不得翻译。

## 4. 可移植发布记录

只存储可移植字段：

```json
{
  "id": "9709-12-2024-ON-Q07",
  "subject": "Mathematics",
  "syllabus_code": "9709",
  "year": 2024,
  "session": "ON",
  "paper": "12",
  "component": "Pure Mathematics 1",
  "question_number": 7,
  "image": "images/questions/9709-12-2024-ON-Q07.png",
  "primary_tag": "1.8",
  "tags": ["1.8", "1.1"],
  "tag_names": {"1.8": "Integration", "1.1": "Quadratics"},
  "classification_confidence": 0.96,
  "quality_status": "ready",
  "question_document": "9709 Mathematics November 2024 Question paper 12.pdf",
  "mark_scheme_document": "9709 Mathematics November 2024 Mark Scheme 12.pdf",
  "question_pages": [10]
}
```

不得存储 PDF 或图片的绝对路径。源文档只保留文件名，且不包含在发布包内。JSON 与 CSV 字段名以及 `quality_status` 等英文元数据规范值必须保持稳定。

## 5. JSON 与 CSV 字段

正式元数据只交付 `metadata/questions.json` 和 `metadata/questions.csv`，不交付 SQL 或数据库文件。

- 两种格式都使用以下 17 个字段，并保持相同顺序：`id`、`subject`、`syllabus_code`、`year`、`session`、`paper`、`component`、`question_number`、`image`、`primary_tag`、`tags`、`tag_names`、`classification_confidence`、`quality_status`、`question_document`、`mark_scheme_document`、`question_pages`。
- JSON 保留数组、对象、数字和空值的原生类型。
- CSV 中的 `tags`、`tag_names`、`question_pages` 使用 JSON 字符串编码；读取后必须与 JSON 值完全一致。
- `mark_scheme_document` 的 JSON 空值在 CSV 中编码为空字段。

下游系统可根据自身 MySQL 表结构导入任一格式，但数据库脚本不属于发布包。

## 6. 质量检查

- 每个稳定 ID 必须恰好对应一张规范 PNG。
- 每题至少有一个标签，且 `primary_tag` 必须属于 `tags`。
- 每个标签前缀必须匹配试卷组件。
- 逐字段比较 JSON 与 CSV，并检查图片数量。
- 复核低置信度题目，但不要删除其已分配标签。
- 确认紧凑图片保留题号、公式、图形、分值和每个小问。
- 拒绝超出支持试卷左边距的题目起点；最终题目不得包含 `Additional page` 或 `BLANK PAGE`。
- 拒绝包含工作区路径、裁剪坐标或流水线临时字段的元数据。
- 要求审计结果 `error_count=0`，并确认发布包中不存在 JSONL、SQL 或数据库目录。
