# AI Agent 预设管理中心规格（极简版）

更新：2026-11-26。对应决策：D26–D28。

## 1. 目标与极简原则

将现有的 `studio`（教师工作台）收口并升级为**极简、开箱即用的 AI Agent 预设管理中心**：

- **极简 5 项配置**：创建或编辑一个 Agent 只需填写 **名称**、**简介**、**一段话 Prompt**、**工具权限（只读 / 可改）**、以及 **可用范围（所有人可用 / 仅教师可用）**。
- **去掉冗余复杂度**：不再要求教师填写开场白、推荐问题、工具使用说明、温度参数、单独引用文件、或逐个挑选模型；同时去掉模板复制流程与「AI 创建助手对话编写」流程。
- **开箱即用、一视同仁**：系统初始化时预置 3 个常用 Agent，它们**与教师手动创建的普通 Agent 完全一致**——可正常编辑、启停、置顶或删除，不需要恢复默认/回退机制。

## 2. 数据库设计（`database/migrations/007_agent_presets.sql`）

### 2.1 扩展 `kl_agents` 表

```sql
ALTER TABLE kl_agents
  ADD COLUMN tool_permission VARCHAR(16) NOT NULL DEFAULT 'read_only' AFTER draft_parameters,
  ADD COLUMN audience VARCHAR(16) NOT NULL DEFAULT 'all' AFTER tool_permission,
  ADD COLUMN preset_key VARCHAR(64) NULL AFTER audience,
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE AFTER preset_key,
  ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT FALSE AFTER enabled,
  ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER pinned,
  ADD UNIQUE KEY uq_kl_agent_preset (preset_key),
  ADD KEY idx_kl_agent_list (status, enabled, audience, pinned, sort_order);
```

- `tool_permission`：仅支持 `'read_only'`（只读，默认）或 `'read_write'`（可改）。
- `audience`：仅支持 `'all'`（所有人可用，默认）或 `'teacher_only'`（仅教师可用）。
- `preset_key`：仅用于 migration 幂等预置以及题库管理页定位默认整理助手；不限制编辑、启停或删除。
- **平台默认对话模型**：在 `kl_settings` 中增加可选配置项 `defaultChatModelId`（在「平台与 API 管理」中配置，未单独配置时回退首个已启用的文字/工具模型），教师新建 Agent 时无需手动选模型。
- **历史会话快照不变性**：延续二期规格，保存/发布时将名称、简介、Prompt 与 `tool_permission` 写入 `kl_versions`，会话启动时固化到 `kl_conversations.snapshot`，不影响已有历史会话。

### 2.2 初始预置 Agent 清单（3 个）

`007_agent_presets.sql` 初始化以下 3 个预置 Agent（`status = 'published', enabled = 1`），后续行为与普通 Agent 完全一致：

| `preset_key` | 名称 | 默认工具权限 | 默认可用范围 | 定位说明 |
| --- | --- | --- | --- | --- |
| `general_tutor` | 通用学习答疑助手 | `read_only`（只读） | `all`（所有人可用） | 检索题库与网盘资料，采用启发式分步讲解帮学生理清思路 |
| `english_writing` | 英语写作批改助手 | `read_only`（只读） | `all`（所有人可用） | 专注英语语法纠错、地道表达润色与结构/评分建议 |
| `question_curator` | 题库整理助手 | `read_write`（可改） | `teacher_only`（仅教师可用） | 协助教师查重、补标签、生成新题草稿、提交修改/批量变更确认卡片 |

## 3. 权限与安全边界

### 3.1 管理权限

| 操作 | 学生 (`student`) | 教师 (`teacher`) |
| --- | --- | --- |
| 查看对当前角色可见且已启用的 Agent 并对话 | 仅 `audience='all'` | 全部（`all` + `teacher_only`） |
| 新建 / 编辑 / 启停 / 置顶 / 排序 / 删除任意非系统 Agent | 拒绝 (403) | 允许 |

### 3.2 工具权限（`只读` vs `可改`）

| 权限级别 | 允许能力 | 安全兜底规则 |
| --- | --- | --- |
| `只读` (`read_only`) | 仅可检索/读取网盘已索引资料与题库题目，不可发起任何写入或修改操作 | 默认值；适合答疑、讲解、批改类助手 |
| `可改` (`read_write`) | 除只读检索外，允许发起创建草稿与修改/整理提案卡片（题库或网盘） | **身份兜底**：仅当当前对话用户为 `teacher` 时生效；**学生与 `read_write` 助手对话时运行时自动降级为只读**。<br>**确认兜底**：涉及修改或删除已有题库/网盘内容时，仍必须弹出确认卡片由教师点击确认后才落库。 |

## 4. 后端 API 契约（`/api/ai/agents/*`）

| 方法与路径 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/ai/agents` | 已登录 | 参数 `scope=all\|manage`（向后兼容 `mine=true`）。`all` 返回 `status='published' AND enabled=1` 且按角色过滤 `audience`（学生仅看 `all`，教师看 `all` + `teacher_only`）；`manage`（仅教师）返回全部非系统助手（可附带 `onlyMine=true` 过滤）。排序：`pinned DESC, sort_order ASC, created_at DESC` |
| `POST /api/ai/agents` | 教师 | 直接创建并保存 Agent：`{ name, description?, content, toolPermission: 'read_only' \| 'read_write', audience: 'all' \| 'teacher_only', enabled?: boolean }`；默认设为 `status='published'` 并生成初始 `kl_versions`，保存即生效 |
| `PUT /api/ai/agents/:id`（兼容 `PUT /api/ai/agents/:id/draft`） | 教师 | 更新 `name`、`description`、`content`、`toolPermission`、`audience`、`enabled`，同步生成新版本 |
| `PATCH /api/ai/agents/:id/meta` | 教师 | 快捷切换 `enabled`、`pinned`、`sort_order` |
| `DELETE /api/ai/agents/:id` | 教师 | 与普通 Agent 一致：若无历史会话可直接删除；若已有 `kl_conversations`，则标记 `status='archived', enabled=0` 保护历史外键 |

## 5. 运行时集成（`runs.js` / `tools.js`）

1. **工具注入判定**：在 `runs.js` 构造会话工具集时，读取 `snapshot.agent.tool_permission` 与当前对话用户角色 `req.user.role`：
   - 当 `tool_permission !== 'read_write'` **或** `req.user.role === 'student'` 时，仅注入只读工具（题库检索、网盘资料检索）。
   - 仅当 `tool_permission === 'read_write'` **且** `req.user.role === 'teacher'` 时，额外注入可改工具（建草稿、提交修改提案卡片）。
2. **可用范围拦截**：在 `POST /api/ai/conversations` 启动对话时校验 `audience`——若 `audience === 'teacher_only'` 且当前用户为学生，返回 `403 仅教师可使用此助手`。
3. **指令组装**：直接使用填写的一段话 Prompt（`content`）作为 System Prompt 主体。

## 6. 小程序前端设计（`.subpage-shell` + `.ws-sheet`）

1. **入口升级**：
   - 在「我的」工作台（教师可见）新增一级卡片入口：**AI Agent 预设管理**（副标题：`管理助手名称、Prompt、权限与可用范围`）。
   - 保留「聊天」侧栏中的快捷入口「管理教学助手」，两者跳转同一管理页。
2. **管理页列表（`.subpage-shell`）**：
   - 顶部统一返回栏 + 右侧 `＋ 新建助手` 主按钮。
   - 教师顶部可按「全部助手 / 我创建的」过滤，查看并管理所有非系统助手。
   - 每行展示：名称、简介、徽标（`只读`/`可改`、`所有人`/`仅教师`、`已启用`/`已停用`、`置顶`）；右侧快捷操作：`编辑`（唤起抽屉）、`启停开关`、`置顶`、`删除`。
3. **极简编辑抽屉（`.ws-sheet`，不跳页）**：
   - 仅 5 个表单控件：
     1. **名称**（单行输入框，必填）
     2. **简介**（简短文本域或单行输入，选填）
     3. **Prompt**（多行文本域，一段话描述角色与要求，必填）
     4. **工具权限**（两段式选择：`只读` / `可改`）
     5. **可用范围**（两段式选择：`所有人可用` / `仅教师可用`）
   - 底部固定栏：`取消` + `保存`。

## 7. 验收案例（`AP-*`）

| 编号 | 验收场景 | 预期结果 |
| --- | --- | --- |
| AP-01 | 入口与权限隔离 | 教师在「我的」看到「AI Agent 预设管理」；学生不可见该入口且调用管理接口返回 403。 |
| AP-02 | 极简 5 项创建 | 教师点击「＋ 新建助手」，在 `.ws-sheet` 中填写名称、简介、Prompt，选择「只读」与「所有人可用」后保存，列表立即出现且学生聊天页可选。 |
| AP-03 | 启停与删除 | 教师切换某助手为「已停用」后，聊天页立即不可选；删除已有会话的助手时保留历史会话记录且从列表隐藏。 |
| AP-04 | 只读权限拦截 | 对「只读」助手发出修改题库或资料的指令，运行时不提供写入工具，不会改动任何数据。 |
| AP-05 | 可改权限与学生降级 | 教师使用「可改」助手可生成修改确认卡片；学生使用「可改」助手时自动降级为只读，无法触发任何写入或提案。 |
| AP-06 | 全局管理与置顶 | 教师在管理列表可编辑、停用或置顶助手，聊天页助手列表顺序随之更新。 |
| AP-07 | 可用范围隔离 | 「题库整理助手」设为 `仅教师可用`；教师在聊天页可见可用，学生聊天列表不显示且直接请求创建会话返回 403。 |
| AP-08 | 预置 Agent 与普通 Agent 一致 | 预置的 3 个助手可正常修改名称/Prompt/可用范围、停用或删除，行为与教师新建的普通 Agent 完全一致。 |
