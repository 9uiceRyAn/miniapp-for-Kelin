# Alevel 工作区操作说明

适用于 `D:/Projects/Alevel` 的现有发布链。路径和数量会变化，恢复时先读取 `docs/QUESTION_IMAGE_REVIEW_HANDOFF.md`，再验证实时文件。本说明不保存某一批次的完成数量。

## 输入、审核状态和发布链

- 正式汇总：`output/question_bank_database_v1/metadata/items.json`。
- 各科发布：`output/*question_database*/metadata/items.json` 与 `images/questions/`，数学 / 经济 / IELTS 的 schema 各有差异。
- 当前连续审核目录：`work/full_image_visual_review_20261020/`，以下称 `R`。
- `R/inventory.jsonl`、各 worker 的 `queue.jsonl`、`ledger.jsonl`、`current_state.json` 或 report / checkpoint 是分配和去重依据。
- STEM / 9231 持久分类来源：`work/stem_classification_manifests/`。修复必须维护实际 manifest 中的 `output_file`；不要凭正式图相对路径猜测原始文件位置。
- 原卷可能在 `work/image_crop_review_20261020/sources/<syllabus>/`、`R/sources/`、`work/economics/source/` 或其他经核实目录；不能假定根目录一定存在 `data/`。
- 暂存修复、原卷渲染、审题理由与备份放 `work/`。不覆盖 QP/MS 原件，不清理旧证据。

读取对应科目 `skills/classify-*/SKILL.md` 和 `references/taxonomy.json`。这些科目合同负责标签边界；本 skill 负责逐图证据和资产一致性。

## 可用工具与渲染

PowerShell 调用设 `login:false`；JSON 明确 `encoding='utf8'`，中文输出用 `sys.stdout.reconfigure(encoding='utf8')`，子进程环境设置 `PYTHONIOENCODING=utf8`。优先使用已有 Python 环境并验证可导入模块。

已使用的环境：`C:/Users/lagdads/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`。可用 PIL、pypdf、pdfplumber、pypdfium2；不要默认存在 fitz 或 requests。

PDF 物理页码 `p` 的渲染示例：

```python
import pypdfium2 as pdfium
doc = pdfium.PdfDocument(source_pdf)
image = doc[p - 1].render(scale=150 / 72).to_pil()
image.save(render_path)
```

用 `view_image` 查看真实图。可以用 PIL 从完整长图创建不遗漏区域的接触页，或按原卷坐标裁切；这属于确定性的文档处理，不应使用生成式图像编辑。

## 元数据和审计格式

正式汇总中：数学 9709 的来源页码通常在 `source_ref.pages`；STEM / 9231 通常在 `details.question_pages`。各科原始发布记录可能直接有 `question_pages`。先看实际记录，不能统一替换所有 `pages` 字段。

分类批次 `R/classification_batch_NNN.json` 的常用字段：

```json
{
  "id": "9702-43-2024-MJ-Q05",
  "before_primary_tag": "18",
  "before_tags": ["18"],
  "after_primary_tag": "18",
  "after_tags": ["18", "20"],
  "confidence": 0.99,
  "review_required": false,
  "reason": "说明独立作答目标及分数依据",
  "qp_total_marks": 13,
  "qp_part_marks": {"a": 2, "b": 6, "c": 5},
  "source_pdf": "实际QP路径",
  "source_pdf_pages": [12, 13],
  "mark_scheme_pdf": "实际MS路径",
  "mark_scheme_pdf_pages": [10]
}
```

另存实际文件哈希、逐图证据、`marks_by_topic`、渲染清单与复核结论；示例不是可以直接发布的完整记录。

来源页码批次 `R/metadata_batch_NNN.json` 使用 `id`、`before_question_pages`、`question_pages`、`reason`、`evidence`；尺寸改动按现有应用脚本 schema 保存。

裁切批次 `R/approved_batch_NNN.json` 使用 `id`、相对项目根的 `original_path` / `staged_path`、`before_size` / `after_size`、`before_sha256` / `after_sha256`、`question_pages`、来源和复核原因。参考真实 `approved_batch_037.json`：保留完整 Q4，只移除底部外国 Q5 矩阵片段。

## 写回规则

1. 主代理检查暂存修复及哈希，先备份所有别名。别名可能是硬链接；用临时文件加原子替换，避免污染备份或答案。
2. `R/apply_crops.py` 按同一资产角色同步 canonical 与 `by_tag` 图。题图和答案即使文件名相似也必须分别处理。
3. **STEM / 9231 必须补做来源同步**：把修后字节写到对应 manifest 的 `output_file`；不存在的父目录可以创建；已存在文件先备份；同步 manifest 宽高 / 页码及 metadata 的 `after_size`。只调用裁切应用脚本不能保证未来导出不回退。
4. 把修复合入 `R/root_approved_repairs.json`，防止后续重建忽略已批准结果。
5. `R/apply_classifications.py` 负责分类、元数据、分科导出、汇总库和预览重建。STEM / 9231 改动不能用 `--defer-stem-export` 跳过导出。读取当前参数定义后再运行。

PowerShell 可以通过 Python 组参数，避免中文路径和多文件参数引号错误：

```python
args = [sys.executable, str(R / 'apply_classifications.py'), str(batch),
        '--metadata', str(R / 'root_approved_repairs.json'),
        *[str(p) for p in sorted(R.glob('metadata_batch_*.json'))]]
result = subprocess.run(args, env={**os.environ, 'PYTHONIOENCODING': 'utf8'},
                        capture_output=True, text=True, encoding='utf8')
print(result.stdout)
print(result.stderr)
raise SystemExit(result.returncode)
```

不要盲目重跑旧 promotion 脚本：有的脚本从当前正式元数据生成 before 字段，重跑会改变历史证据。批次号先查现有最大编号，正式写回保持串行。

## 验收和停止

- `R/verify_root_release.py`：比对正式输出、已应用分类、来源页码、裁切结果。
- `R/check_evidence.py`：证据路径、图片哈希与台账一致性；必须检查输出 JSON 的 `error_count`，不能只看进程退出码。
- `R/update_progress.py`：各 worker ledger 的去重进度；根审计分片未合并前不会计入。
- `tools/export_stem_question_database.py` 的 `audit()`：正式 STEM 范围、字段和资产检查；保存实际报告。
- 仅修改数据时使用上述针对性检查；生产代码改动再运行相关测试。

停止时保持正式结果不变，记录未合并根 ledger 和未写入子批次。`checkpoint.json` / `classification_checkpoint.json` 设为 `paused_by_user`，完整核验标志保持 false。保存文件清单与下一动作；重新开始必须来自用户指令。
