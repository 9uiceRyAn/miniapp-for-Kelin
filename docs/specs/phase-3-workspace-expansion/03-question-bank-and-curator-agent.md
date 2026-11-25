# 题库管理增强、题库整理 AI 助手与共享管理员密码门禁规格

更新：2026-11-26。对应决策：D29–D34、D40。

---

## 第一部分：题库管理权限与分类体系增强

### 1.1 权限统一（D29、D40）

- **现状基线**：当前 `/api/question-bank/admin/*` 与前端 `pages/home` 仅限拥有 `kl_capabilities` 中 `admin` 权限的账号访问。
- **目标行为**：**移除独立的 `admin` 权限体系，所有教师拥有完全相同的题库管理权限**。
  - 后端：将 `/api/question-bank/admin/*` 路由守卫由 `requireAdmin` 调整为 `requireTeacher`。
  - 前端：`pages/learning/index.wxml`、`templates/workspace-sidebar.wxml` 与 `pages/home/home.*` 中，所有「题库管理」入口与权限校验由 `admin` 改为 `teacher`。

### 1.2 分类体系与标签树表结构（`database/migrations/008_question_taxonomy_and_curator.sql`）

取代当前只能从已有题目聚合 facets、以及编辑题目时只能手敲 `编号 | 名称` 纯文本的方式，新增结构化分类表：

```sql
CREATE TABLE IF NOT EXISTS kl_subjects (
  code VARCHAR(100) PRIMARY KEY,
  label VARCHAR(191) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kl_collections (
  code VARCHAR(100) PRIMARY KEY,
  subject_code VARCHAR(100) NOT NULL,
  label VARCHAR(191) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_kl_col_subject (subject_code),
  CONSTRAINT fk_kl_col_subject FOREIGN KEY (subject_code) REFERENCES kl_subjects(code) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kl_taxonomy_tags (
  id VARCHAR(36) PRIMARY KEY,
  collection_code VARCHAR(100) NOT NULL,
  parent_id VARCHAR(36) NULL,
  code VARCHAR(100) NOT NULL,
  label VARCHAR(191) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_kl_tax_tag (collection_code, code),
  KEY idx_kl_tax_parent (parent_id),
  CONSTRAINT fk_kl_tax_col FOREIGN KEY (collection_code) REFERENCES kl_collections(code) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- **存量数据回填**：Migration 自动从现有 `kl_revisions` 与 `kl_tags` 中提取不重复的 `subject`、`collection_code` 与 `(collection_code, code, label)` 回填到上述三张表，确保现有题库立即平滑接入。

### 1.3 分类体系 CRUD API（`/api/question-bank/admin/*`）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/question-bank/admin/taxonomy` | 返回完整的学科 → 数据集 → 知识点标签树结构 |
| `POST /api/question-bank/admin/subjects` | 新增学科（`code`, `label`, `sortOrder`） |
| `PATCH /api/question-bank/admin/subjects/:code` | 修改学科名称、排序或启停 |
| `DELETE /api/question-bank/admin/subjects/:code` | 若旗下仍有关联数据集或未删除题目，返回 `409` 拒绝并提示数量 |
| `POST /api/question-bank/admin/collections` | 在指定学科下新增数据集 |
| `PATCH /api/question-bank/admin/collections/:code` | 修改数据集名称、排序、启停 |
| `DELETE /api/question-bank/admin/collections/:code` | 若仍有关联题目，返回 `409` 拒绝 |
| `POST /api/question-bank/admin/tags` | 在指定数据集下新增知识点标签（支持 `parentId` 构建多级树） |
| `PATCH /api/question-bank/admin/tags/:id` | 重命名标签、调整父节点或排序（可选同步更新关联题目展示标签） |
| `DELETE /api/question-bank/admin/tags/:id` | 若仍有题目引用该标签，返回 `409` 拒绝或要求先解除引用 |

### 1.4 批量操作 API

- `POST /api/question-bank/admin/items/batch`
  - 请求体：`{ ids: string[], action: 'publish' | 'draft' | 'provisional' | 'approve_review' | 'mark_review' | 'add_tags' | 'remove_tags' | 'delete' | 'restore', tags?: Array<{ code: string, label: string }> }`
  - 行为：在数据库事务中逐题处理。涉及内容/状态/标签变更时，沿用 `question-management.js` 的不可变修订机制（生成新 `kl_revisions` 并更新 `current_revision`），保留完整历史修订；删除/恢复则更新 `visibility`。单次上限 200 题，返回 `{ succeeded, failed }`。

### 1.5 AI 辅助录题与解析（拍照 / PDF 自动切题）

- `POST /api/question-bank/admin/ai-ingest`
  - 输入：`multipart/form-data`（支持单张/多张题目图片 `.png/.jpg/.jpeg/.webp` 或 `.pdf`），可选 `subject`、`collection`。
  - 处理：
    1. 将文件存入 `media.blob`（复用现有题库媒体存储），获取附件凭证。
    2. 调用系统配置的视觉模型（`visionModelId`，PDF 可先提取文本或转页图）识别题目边界、题干文本、参考答案/解析，并结合目标数据集已有 `kl_taxonomy_tags` 推荐知识点标签。
  - 输出：返回待确认草稿候选数组（**不直接发布**），包含 `title`、`questionText`、`answerText`、`suggestedTags`、`attachments`（已关联上传媒体）。
  - 落库：前端在弹窗中展示识别结果供教师微调后，点击「保存为草稿」或「直接发布」调用现有 `POST /api/question-bank/admin/items` 落库。

### 1.6 小程序题库管理 UI 增强（`pages/home`）

- **顶部操作区**：保留 `导入题库`、`＋ 新建题目`，新增 `分类与标签管理`、`AI 拍照录题`、`AI 整理题库`（打开题库整理助手）。
- **列表多选模式**：点击「批量管理」进入多选态，支持全选当前页、勾选多题后唤起底部批量操作栏（批量发布 / 设为草稿 / 审核通过 / 批量打标签 / 批量删除）。
- **题目编辑弹窗升级**：知识点标签区域支持从「可视化标签选择器」勾选数据集下的已有标签，同时保留快捷新建标签入口。

---

## 第二部分：系统预设「题库整理 AI 助手」

### 2.1 架构与生命周期（D33）

完全对齐现有的 [library-agent.js](../../../backend/src/learning/library-agent.js) 安全模式：

- **与预置 Agent 统一**：初始化预置的「题库整理助手」（`preset_key = 'question_curator'`，`tool_permission = 'read_write'`，`audience = 'teacher_only'`）即普通可编辑 Agent，教师可在 Agent 预设管理中随时修改其 Prompt、停用或删除。
- **前端入口**：在「题库管理」页顶部点击 `AI 整理题库`，优先打开 `preset_key = 'question_curator'`（若已被停用或删除，则提示并允许改选其他 `read_write` 助手或恢复创建），调用 `POST /api/ai/question-curator/conversation` 获取或创建会话并跳转到 `pages/chat`（支持带入当前筛选条件或选中的题目上下文）。

### 2.2 工具集与确认边界

| 工具名称 | 类型 | 是否需人工确认 | 说明 |
| --- | --- | --- | --- |
| `search_questions` | 只读查询 | 否 | 按学科、数据集、标签、发布状态、待审核状态、关键词检索题目 |
| `get_question_detail` | 只读查询 | 否 | 查看单题完整题干、答案、标签与附件信息 |
| `list_taxonomy` | 只读查询 | 否 | 读取学科、数据集与知识点标签树 |
| `create_question_draft` | 写入草稿 | 否（仅建草稿） | 根据用户发来的文字/图片/PDF 直接生成 `release_status='draft', review_required=1` 的新题草稿 |
| `propose_question_update` | **修改已有题** | **是（必须弹确认卡片）** | 提交修改题干、答案、标签或发布状态的提案卡片；绑定 `expectedRevisionId` 防并发覆盖 |
| `propose_question_batch_update` | **批量修改/删除** | **是（必须弹确认卡片）** | 提交批量改标签、批量审核、批量发布或软删除提案卡片，卡片上明确列出影响题数与样本标题 |
| `propose_taxonomy_change` | **修改分类标签** | **是（必须弹确认卡片）** | 提交新增/重命名/整理知识点标签树的提案卡片 |

### 2.3 确认卡片接口与安全校验

- `POST /api/ai/question-curator/conversation`：打开或新建当前用户的题库整理 AI 助手会话。
- `POST /api/ai/conversations/:id/question-actions/:actionId/confirm`：教师点击确认卡片后执行落库；后端二次校验权限、修订号（`expectedRevisionId`）与参数合法性，防止过期提案或模型幻觉参数直接写库。
- `POST /api/ai/conversations/:id/question-actions/:actionId/reject`：标记卡片已取消，不修改题库。

---

## 第三部分：共享管理员密码门禁（移除独立 `admin` 权限）

### 3.1 安全机制与 `admin` 权限清理（D34、D40）

系统不设独立的 `admin` 账号角色，全面移除 `kl_capabilities` 中的 `admin` 权限判定，改为**两角色（`student` / `teacher`）+ 共享管理员密码门禁**：

- **受保护页面（统一使用同一共享管理员密码）**：
  1. **账号管理**（`pages/accounts`，`/api/teacher-admin/*`：用户查询、改名、重置密码、停用/启用、注册码管理）
  2. **平台与 API 管理**（`pages/admin`，`/api/ai/admin/*` 与 `/api/ai/connections/*`：模型连接、API 密钥、能力验证、价格版本、全平台用量统计）
- **环境变量**：使用统一的 `ADMIN_MANAGEMENT_PASSWORD_HASH`（PBKDF2 哈希，向后兼容读取原 `MODEL_MANAGEMENT_PASSWORD_HASH`）。若未配置则返回 `503 尚未配置管理员密码`（fail-closed，禁止无密码放行）。
- **防爆破与共享会话令牌**：
  - 同一用户 15 分钟内连续输错 5 次返回 `429 尝试次数过多，请稍后再试`。
  - 校验通过后签发随机令牌（有效期 15 分钟），绑定当前登录态 `req.authTokenHash`，前端通过请求头 `X-Management-Token` 传递。**解锁一次后，15 分钟内可连续访问「账号管理」和「平台与 API 管理」两个界面，无需重复输密码。**

### 3.2 后端接口变更（`router.js` & `teacher-admin.js`）

- 抽离公共门禁模块（如 `backend/src/utils/admin-gate.js`），提供 `unlock` 与 `requireAdminGate` 中间件。
- 新增统一解锁入口 `POST /api/admin-gate/unlock`（同时保留 `/api/ai/connections/unlock` 兼容指向同一门禁），需 `requireAuth + requireTeacher`。
- `/api/teacher-admin/*`（`GET /users`、`PATCH /users/:id`、`GET /codes`、`PUT /codes/:role`）与 `/api/ai/admin/*`、`/api/ai/connections/*` 统一挂载 `requireTeacher + requireAdminGate`；**移除 `router.js` 中的 `requireAdmin`（`c.admin`）检查**。
- 令牌缺失、无效或过期时统一返回 `403`（`{ success: false, code: 'MANAGEMENT_LOCKED', message: '请输入管理员密码' }`）。

### 3.3 小程序前端变更（`pages/learning`、`pages/accounts`、`pages/admin`）

- **个人中心收口**：移除 `pages/learning` 个人中心的「平台管理员」身份徽标，将原重复的「API 管理」与「平台管理」合并为单一入口 **「平台与 API 管理」**，对所有教师可见。
- **门禁解锁体验**：进入 `pages/accounts` 或 `pages/admin` 时检查内存中/短期本地存储的共享 `X-Management-Token`；未解锁时**不发起业务请求**，直接展示统一的 `.ws-gate-card` 密码解锁视图。
- 解锁成功后加载页面数据；若操作过程中接口返回 `403`（令牌过期），自动清空令牌并切回解锁卡片提示重新输入密码。

---

## 4. 验收案例（`QM-*` & `AC-*`）

### 题库管理与整理助手（`QM-*`）

| 编号 | 验收场景 | 预期结果 |
| --- | --- | --- |
| QM-01 | 教师权限开放 | 普通教师账号登录「我的」与侧栏可见「题库管理」，可正常进入 `pages/home` 并调用 `/api/question-bank/admin/*`；学生仍返回 403。 |
| QM-02 | 分类与标签树 CRUD | 教师新增学科/数据集/多级知识点标签成功；删除仍有关联题目的学科或标签时被 409 拦截。 |
| QM-03 | 可视化标签选择 | 新建/编辑题目时可通过标签选择器勾选知识点，不再强制纯手敲文本。 |
| QM-04 | 批量操作与修订保留 | 多选 5 道草稿题目执行「批量发布」或「批量打标签」全部成功，且每道题保留历史修订记录。 |
| QM-05 | AI 拍照/PDF 录题 | 上传题目图片后返回识别出的题干、参考答案与推荐标签草稿，确认后成功保存为草稿题。 |
| QM-06 | 整理助手只读与建草稿 | 在「题库整理 AI 助手」中让其查找待审核题目或根据文本生成新题草稿，可直接完成并返回结果。 |
| QM-07 | 整理助手改/删必须确认 | 让助手修改某道已有题目的标签或删除重复题时，助手只能输出操作确认卡片，数据库此时未变化；点击「确认」后才真正更新/删除，点击「取消」则保持原样。 |
| QM-08 | 并发修订保护 | 确认卡片弹出期间若另一教师手动编辑了同一题，点击卡片确认时因 `expectedRevisionId` 不匹配返回 409 冲突提示，避免静默覆盖。 |

### 共享管理员密码门禁（`AC-*`）

| 编号 | 验收场景 | 预期结果 |
| --- | --- | --- |
| AC-01 | 未解锁拦截 | 未带有效 `X-Management-Token` 访问 `GET /api/teacher-admin/users` 或 `GET /api/ai/admin/models` 直接返回 403 `MANAGEMENT_LOCKED`；`pages/accounts` 与 `pages/admin` 进入时均先显示密码解锁页。 |
| AC-02 | 正确密码解锁与双页共享 | 输入正确共享管理员密码后返回 15 分钟令牌，自动加载当前页，且 15 分钟内切换进入另一个受保护页面无需重复输密码。 |
| AC-03 | 错误密码限流 | 连续输错 5 次后触发 429 锁定提示，阻止继续试错。 |
| AC-04 | 未配置密码 fail-closed | 服务端未配置管理密码哈希时返回 503，绝不跳过校验。 |
| AC-05 | 令牌过期回退 | 令牌失效后执行搜索、改密或模型操作，接口返回 403，页面自动回到密码解锁界面。 |
| AC-06 | 无独立 admin 权限 | 任意普通教师账号登录均可看到统一入口（「题库管理」、「AI Agent 预设管理」、「账号管理」、「平台与 API 管理」），不再依赖 `kl_capabilities` 授权。 |
