# 分类 Skill 总索引

跨科逐图修正使用 [review-and-repair-exam-images](review-and-repair-exam-images/SKILL.md)，覆盖题图边界、分类证据、来源页码、重新裁切及发布同步。当前停止与恢复入口见 [接手文档](../docs/QUESTION_IMAGE_REVIEW_HANDOFF.md)。以下各科 skill 继续负责各自分类合同。

当前工作区的分类规则统一采用中文说明。每个考试科目或模块拥有独立目录、独立 `SKILL.md` 和独立 `references/taxonomy.json`。开始分类或审核前，只读取对应科目的 skill。

| 科目或模块 | Skill | 分类范围 |
| --- | --- | --- |
| 物理 9702 | `classify-cambridge-physics-9702/` | Paper 1、2、4；主题 1–25 |
| 化学 9701 | `classify-cambridge-chemistry-9701/` | Paper 1、2、4；主题 1–37 |
| 生物 9700 | `classify-cambridge-biology-9700/` | Paper 1、2、4；主题 1–19 |
| 计算机科学 9618 | `classify-cambridge-computer-science-9618/` | Paper 1–3 分类；coding 可保留未分类 |
| 进阶数学 9231 | `classify-cambridge-further-mathematics-9231/` | Paper 1–4；主题 1.1–4.5 |
| 数学 9709 | `classify-cambridge-mathematics-9709/` | Paper 1–6；主题 1.1–6.5 |
| 经济 9708 | `classify-cambridge-economics-9708/` | AS.U1–U6、A2.U7–U11 |
| 中文 9868 | `classify-cambridge-chinese-9868/` | 当前仅按年份 `year_only` |
| IELTS 听力与阅读 | `classify-ielts-listening-reading/` | 题型 + 听力场景/阅读主题 |
| IELTS 写作 | `classify-ielts-writing/` | Task 1 图表类型、Task 2 主题 |

## 统一工作合同

1. `SKILL.md` 使用统一六段结构：适用范围、分类合同、判定流程、输出合同、代理分工与验收、常见错误。
2. 由低成本 subagent 执行互不重叠的批量初分；主代理维护 taxonomy、复核低置信度和执行最终审计。
3. `primary_tag` 必须存在于 `tags` 中；有意未分类的 coding 记录按计算机 skill 的专用合同处理。
4. 不从 isolated keyword 直接定类；必须结合完整题目、图表、原文和评分标准。
5. 发布前检查 ID、分类范围、标签合法性、状态一致性、资产路径和记录数量。
