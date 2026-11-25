# 网盘式资料管理规格（Cloud Drive Library）

更新：2026-11-26。对应决策：D21–D25。

## 1. 目标与定位

将现有的「资料」Tab（当前对教师仅显示「教学资料管家」入口，对学生仅显示平铺的 `kl_resources` 文本检索）重构为**真正的多级文件夹网盘**：

- **文件存储为中心**：支持任意层级文件夹树、上传/下载/预览/重命名/移动、文件夹 ZIP 导出、回收站与跨目录搜索。
- **保留 v0.1 个人标记**：`user_file_marks` 继续按 `(user_id, file_id)` 独立隔离，在文件夹列表与搜索结果中均可标记与「隐藏已标记」。
- **轻量 AI 索引联动**：常见文档上传后自动后台提取文本并建轻量索引，供 AI Agent 检索；视频、压缩包等大文件仅做存储，不阻塞上传。

## 2. 数据库设计（`database/migrations/006_cloud_drive.sql`）

### 2.1 新增 `drive_folders` 表

```sql
CREATE TABLE IF NOT EXISTS drive_folders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  parent_id BIGINT UNSIGNED NULL,
  name VARCHAR(191) NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  legacy_category CHAR(1) NULL,
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  deleted_by BIGINT UNSIGNED NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_drive_parent (parent_id, deleted_at),
  KEY idx_drive_owner (owner_id),
  UNIQUE KEY uq_drive_legacy_cat (legacy_category),
  CONSTRAINT fk_drive_folder_parent FOREIGN KEY (parent_id) REFERENCES drive_folders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_drive_folder_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- **同级同名约束**：同一父目录下（含根目录 `parent_id IS NULL`）处于未删除状态（`deleted_at IS NULL`）的文件夹名称不得重复。由于 MySQL 唯一索引对 `NULL` 不去重，需在应用层校验（或在表中使用 `parent_scope = COALESCE(parent_id, 0)` + `is_active = IF(deleted_at IS NULL, 1, NULL)` 生成列唯一索引）。

### 2.2 扩展 `files` 表（向后兼容增量字段）

保持 `files.id`、`files.category`、`files.original_name`、`files.stored_name`、`files.storage_path`、`files.uploader_id`、`user_file_marks` 外键与语义不变，增量添加：

```sql
ALTER TABLE files
  ADD COLUMN folder_id BIGINT UNSIGNED NULL AFTER category,
  ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL AFTER updated_at,
  ADD COLUMN deleted_by BIGINT UNSIGNED NULL DEFAULT NULL AFTER deleted_at,
  ADD COLUMN ai_resource_id VARCHAR(36) NULL AFTER deleted_by,
  ADD COLUMN ai_index_status VARCHAR(16) NOT NULL DEFAULT 'none' AFTER ai_resource_id,
  ADD COLUMN ai_index_error TEXT NULL AFTER ai_index_status,
  ADD KEY idx_files_folder (folder_id, deleted_at),
  ADD KEY idx_files_ai_resource (ai_resource_id),
  ADD CONSTRAINT fk_files_folder FOREIGN KEY (folder_id) REFERENCES drive_folders(id) ON DELETE RESTRICT;
```

### 2.3 旧数据自动迁移规则

1. **v0.1 A–E 分类迁移**：
   - 在 `drive_folders` 根目录（`parent_id = NULL`）创建 5 个默认文件夹：`A 类资料`、`B 类资料`、`C 类资料`、`D 类资料`、`E 类资料`（`legacy_category` 分别为 `'A'`..`'E'`，`owner_id` 取系统首个启用中的教师账号）。
   - 执行 `UPDATE files f JOIN drive_folders d ON d.legacy_category = f.category SET f.folder_id = d.id WHERE f.folder_id IS NULL`。
   - 保留原 `files.id` 与 `user_file_marks` 不变。
2. **已有公共教学文档（`kl_resources`）迁移**：
   - 若存在 `type='document' AND visibility='public'` 且尚未关联 `files.ai_resource_id` 的 `kl_resources`，在根目录创建 `公共教学资料` 文件夹（或按需挂载），为缺失物理文件记录的纯文本/文档条目补建对应 `files` 索引记录并关联 `ai_resource_id`，确保原有 `resourceId` 引用持续有效。

## 3. 权限与回收站规则

### 3.1 读写与归属权限

| 操作 | 学生 (`student`) | 教师 (`teacher`) |
| --- | --- | --- |
| 浏览目录树、下载、预览、ZIP 导出 | 允许全部未删除文件/目录 | 允许全部 |
| 上传文件、新建文件夹 | 允许在任意未删除目录下创建，记录 `owner_id = req.user.id` | 允许，记录 `owner_id = req.user.id` |
| 重命名 / 移动文件 | 仅当 `files.uploader_id === req.user.id` | 允许全部 |
| 重命名 / 移动文件夹 | 仅当 `drive_folders.owner_id === req.user.id` | 允许全部 |
| 软删除文件（移入回收站） | 仅当 `files.uploader_id === req.user.id` | 允许全部 |
| 软删除文件夹（移入回收站） | 仅当 `drive_folders.owner_id === req.user.id` **且**该目录及其子孙目录中不包含其他用户创建的文件/文件夹；否则返回 `403`（提示「文件夹内包含其他用户上传的资料，无法删除」） | 允许全部 |
| 回收站查看与恢复 | 仅可查看并恢复自己删除的项（且仅当原父目录仍存在或恢复至根目录） | 可查看并恢复全部项 |
| 回收站彻底删除 | 拒绝 (`403`) | 允许，彻底清理磁盘文件、DB 记录与 `user_file_marks` |

### 3.2 级联软删除与恢复

- **软删除文件夹**：在事务中递归找出所有子孙文件夹与文件，统一标记 `deleted_at = NOW(), deleted_by = req.user.id`。若文件已关联 `ai_resource_id`，同步将 `kl_resources.visibility` 设为 `'withdrawn'`，使其从 AI 检索中下线。
- **恢复**：恢复文件时若其原 `folder_id` 仍在回收站，允许选择「恢复到根目录」或自动连带恢复路径；同步将关联 `kl_resources.visibility` 恢复为 `'public'`。
- **彻底删除**：仅教师可执行。先删除物理文件（忽略 `ENOENT`），清理关联的 `kl_resources`（或标记 `withdrawn` 防止已引用会话损坏），再删除 `files` 记录（级联删除 `user_file_marks`）。

## 4. 后端 API 契约（`/api/drive/*`）

> 兼容约定：保留现有 `/api/files/*` 与 `/api/marks/*` 路由不破坏已有客户端；`/api/files/upload` 缺省 `folderId` 时自动写入对应 `category` 映射的默认目录。

| 方法与路径 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/drive/tree` | 已登录 | 返回完整未删除文件夹树（供移动选择器与侧栏快速跳转） |
| `GET /api/drive/items` | 已登录 | 查询参数：`folderId`（空为根目录）、`q`（非空时执行跨目录搜索）、`hideMarked`（`true`/`false`）、`onlyMarked`、`sort`（`name`/`time`/`size`）。返回 `{ breadcrumbs, folders, files, marks }` |
| `POST /api/drive/folders` | 已登录 | Body: `{ parentId, name }`。校验同名冲突后创建目录 |
| `PATCH /api/drive/folders/:id` | 归属校验 | Body: `{ name?, parentId? }`。移动时必须做环路检测（禁止移入自身或子孙目录） |
| `DELETE /api/drive/folders/:id` | 归属校验 | 软删除目录及其子树 |
| `POST /api/drive/files/upload` | 已登录 | `multipart/form-data`：`file`、`folderId`、`clientFileName`。沿用 `UPLOAD_ROOT` 与 `MAX_UPLOAD_MB`（200MB）。常见文档异步触发 AI 索引 |
| `PATCH /api/drive/files/:id` | 归属校验 | Body: `{ name?, folderId? }`。重命名或移动文件 |
| `DELETE /api/drive/files/:id` | 归属校验 | 软删除文件 |
| `GET /api/drive/files/:id/download` | 已登录 | 下载单文件（支持 `Range` 或直接 `res.download`） |
| `GET /api/drive/folders/:id/export` | 已登录 | 将指定文件夹下的全部未删除文件按相对路径打包为 ZIP 导出 |
| `POST /api/drive/files/:id/reindex` | 教师或上传者 | 手动重试失败的 AI 文本索引 |
| `GET /api/drive/trash` | 已登录 | 返回当前用户可见的回收站文件与文件夹列表 |
| `POST /api/drive/trash/restore` | 权限校验 | Body: `{ type: 'file' \| 'folder', id, targetFolderId? }` |
| `DELETE /api/drive/trash/:type/:id` | 教师 | 彻底清除磁盘文件与数据库记录 |

## 5. 网盘与 AI 轻量索引联动

1. **自动索引白名单**：上传扩展名为 `.pdf`、`.docx`、`.txt`、`.md`、`.png`、`.jpg`、`.jpeg`、`.webp` 的文件时，上传接口立即返回 `201`（`ai_index_status = 'queued'`），后台异步复用 `backend/src/learning/documents.js` 的解析与分段逻辑生成 `kl_resources` 与 `kl_chunks`，完成后更新 `ai_index_status = 'ready'`。
2. **非文本/大文件跳过**：`.mp4`、`.mov`、`.zip`、`.rar`、`.xlsx` 等不进入自动文本解析，直接置为 `ai_index_status = 'none'`，纯作网盘存储。
3. **全网盘检索**：所有已索引的常见文档（`ai_index_status = 'ready'`）统一纳入公共资料检索范围，供具有只读或可改权限的 AI Agent 检索命中。
4. **原「教学资料管家」定位调整**：不再独占「资料」Tab；可在网盘顶部工具栏保留一个轻量的「AI 整理」角标入口（仅教师可见），或由网盘原生管理功能逐步替代。

## 6. 小程序前端设计（`pages/learning` 资料 Tab）

- **顶部工具栏**：
  - 面包屑导航（`根目录 › A 类资料 › 高数讲义`），点击任意层级快速返回。
  - 搜索栏：支持输入文件名/关键词全网盘搜索；右侧开关「隐藏已标记」。
  - 操作按钮组：`＋ 新建文件夹`、`上传文件`（桌面端直接选本地文件；手机端复用相册/拍照/微信聊天文件）、`导出本目录`、`回收站`。
- **列表项展示**：
  - 文件夹行：文件夹图标、名称、创建者与更新时间；右侧「⋯」操作菜单（重命名、移动、删除 — 仅对有权限的操作显示）。
  - 文件行：按扩展名区分图标、原始文件名（不展示自增 ID）、文件大小、上传者显示名、北京时间（UTC+8 12 小时制 AM/PM）、可选轻量 AI 状态徽标（如 `已建索引`）、个人标记复选框；点击文件直接预览或下载，「⋯」菜单提供下载/分享/重命名/移动/删除。
- **移动选择器**：弹窗展示网盘目录树（`GET /api/drive/tree`），支持选择目标目录后一键移动。

### 6.1 原生微信 API 与跨端适配清单

网盘所有文件选择、上传、下载、预览与分享必须调用微信小程序原生 API，并严格区分桌面端（Windows / Mac）与移动端（iOS / Android）：

- **平台判断**：使用 `wx.getDeviceInfo()` 读取 `platform`（`windows`/`mac` 为桌面端，`ios`/`android` 为移动端），不使用已废弃的 `wx.getSystemInfoSync()`。
- **选择与上传**：
  - 桌面端直接调用 `wx.chooseMessageFile({ count, type: 'all' })`；
  - 移动端通过 `wx.showActionSheet` 提供：相册图片或视频（`wx.chooseMedia`, `sourceType: ['album']`）、拍照或录像（`wx.chooseMedia`, `sourceType: ['camera']`）、微信聊天文件（`wx.chooseMessageFile`）；
  - 统一通过 `wx.uploadFile` 上传至 `/api/drive/files/upload`，使用 `UploadTask.onProgressUpdate` 展示实时上传进度。
- **下载与预览**：
  - 统一使用 `wx.downloadFile`（携带 `Authorization: Bearer <token>` 请求头，配合 `DownloadTask.onProgressUpdate`）；
  - 办公文档（`pdf/doc/docx/xls/xlsx/ppt/pptx`）使用 `wx.openDocument({ filePath, fileType, showMenu: true })`（**必须显式传入 `fileType` 以兼容 iOS**）；
  - 图片/视频使用 `wx.previewMedia`（或 `wx.previewImage`）；音频使用 `wx.createInnerAudioContext()`。
- **保存与分享（PC / 移动端分流，关键避坑）**：
  - **桌面端（Windows / Mac）**：不支持 `wx.shareFileMessage`（调用会报错），下载或导出 ZIP 后必须调用 `wx.saveFileToDisk({ filePath })` 弹出系统「另存为」窗口保存到本地磁盘。
  - **移动端（iOS / Android）**：由用户点击触发 `wx.shareFileMessage({ filePath, fileName })` 转发至微信好友或文件传输助手。
  - 文件夹 ZIP 导出（`GET /api/drive/folders/:id/export`）同样遵循上述 PC（`wx.saveFileToDisk`）/ 移动端（`wx.shareFileMessage`）分流。

## 7. 验收案例（`DR-*`）

| 编号 | 验收场景 | 预期结果 |
| --- | --- | --- |
| DR-01 | 数据迁移兼容性 | 原 v0.1 `files` 表的 A–E 文件全部出现在对应根目录文件夹中；原 `files.id` 与 `user_file_marks` 个人标记完整保留。 |
| DR-02 | 多级目录与环路保护 | 教师/学生新建多层子文件夹并移动文件；尝试将父文件夹移动到自身子目录时接口返回 400 拒绝。 |
| DR-03 | 学生权限边界 | 学生上传文件、建子目录成功；学生重命名/删除自己上传的文件成功；学生尝试重命名/删除教师或其他学生的文件时返回 403 且前端隐藏对应按钮。 |
| DR-04 | 文件夹含他人文件保护 | 学生尝试删除自己创建但内部包含他人上传文件的文件夹时返回 403，提示原因。 |
| DR-05 | 回收站软删除与恢复 | 删除文件/文件夹后进入回收站，原列表不可见、AI 检索下线；恢复后原文件、个人标记与 AI 索引同步恢复。 |
| DR-06 | 回收站彻底清理 | 学生无法彻底清理回收站（403）；教师彻底清理后，磁盘物理文件与数据库记录均被移除。 |
| DR-07 | 跨目录搜索与个人标记 | 输入关键词可跨目录命中文件；勾选「隐藏已标记」可与搜索条件组合生效且用户间完全隔离。 |
| DR-08 | 文件夹 ZIP 导出 | 点击导出目录可下载包含子目录文件的 ZIP 压缩包。 |
| DR-09 | 自动 AI 索引（文本类） | 上传 PDF/TXT/Word/图片后秒级返回上传成功，后台异步将 `ai_index_status` 更新为 `ready` 并可被 AI Agent 检索命中。 |
| DR-10 | 大文件/视频跳过索引 | 上传 `.mp4` 或 `.zip`（≤200MB）正常存储，`ai_index_status = 'none'`，不触发解析失败告警。 |
