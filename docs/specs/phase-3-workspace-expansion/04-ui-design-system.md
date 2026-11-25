# 小程序统一 UI 样式与组件规范（UI Design System）

更新：2026-11-26。对应决策：D36–D39。

## 1. 现状问题与统一目标

当前小程序并存着 4 套互不统一的样式实现：

1. **主工作台（`.workspace-shell`）**：`learning`、`chat`、`question/detail`、`home` 使用，极简白底细边框 + `#242424` 炭黑主色 + `700px` 断点。
2. **旧版 `.learning-page`**：`studio` 与 `admin` 使用，无统一顶栏、灰底无边框按钮、大块堆叠卡片、`900px` 断点。
3. **独立硬编码 `accounts.wxss`**：账号管理页手写了 `#81838a` 重边框、输入框文字居中、`14px/8px` 混合圆角、`480px/340px` 断点。
4. **品牌色分裂**：早期 `agent.md` 约定 `#9B1F58` 酒红，实际工作台已采用 `#242424` 黑白灰。

本规范将全站收口为**唯一的设计 Token 与组件体系**，并随第三期功能开发一并完成旧页面改造。

## 2. 已确认 UI 规范决策（D36–D39）

| 编号 | 主题 | 已确认决策 |
| --- | --- | --- |
| D36 | 视觉主色调 | 全站以极简黑白灰为主（`#ffffff` 画布、`#f7f7f8` 浅灰表面、`#242424` 炭黑主强调色、`#e9e9e9` 极细边框、`#a12540` 危险/报错色）；COLLINS 品牌酒红 `#9B1F58` 仅保留用于 Logo 与极少数品牌标识，不用于全站常规按钮或选中态底色。 |
| D37 | 统一工作台外框 | 全站主 Tab（聊天/题库/资料/我的）及「我的空间」下所有功能页面（用量与费用、AI Agent 预设管理、题库管理、账号管理、平台与 API 管理）**统一采用 `.workspace-shell`**，保留左上角 `☰` 抽屉侧栏自由切换与底部 4 Tab 导航，不再使用两套割裂的外框。 |
| D38 | 抽屉弹窗编辑范式 | 全站所有新建、编辑、移动目录、分类标签管理、导入预览等表单操作，一律使用统一的**抽屉弹窗（Sheet）**，尽量不跳转新页面。 |
| D39 | 旧页收口范围 | 随第三期开发一并将 `pages/accounts`、`pages/admin`、`pages/studio`、`pages/home` 全部收口到同一套公共 Token 与组件样式，消除硬编码色值与碎片断点。 |

## 3. 单一数据源设计 Token（`miniprogram/styles/workspace-tokens.wxss`）

**硬性约束**：所有页面与组件 `.wxss` 必须通过 CSS 变量引用颜色、圆角、字号与间距；**禁止**在页面级样式中硬编码色值（如 `#81838a`、`#55565b`、`#8c273b`）或新增自定义媒体查询断点（全站仅使用 `@media (max-width: 700px)`）。

### 3.1 色彩 Token

| 变量名 | 建议值 | 用途 |
| --- | --- | --- |
| `--ws-canvas` | `#ffffff` | 页面主背景、输入框底色、Sheet 底色 |
| `--ws-sidebar` | `#f7f7f8` | 侧栏、只读卡片、折叠详情、确认卡片底色 |
| `--ws-muted` | `#f1f1f2` | 徽标底色、次级按钮悬停/轻底色 |
| `--ws-selected` | `#e8e8ea` | 列表/侧栏选中态底色 |
| `--ws-text` | `#202020` | 主正文、标题文字 |
| `--ws-secondary` | `#777777` | 副标题、辅助说明、标签文字 |
| `--ws-tertiary` | `#969696` | 占位符、弱提示、箭头图标 |
| `--ws-border` | `#e9e9e9` | 1px 极细分割线、输入框与卡片边框 |
| `--ws-accent` | `#242424` | 主按钮底色、输入框聚焦边框、选中边框 |
| `--ws-on-accent` | `#ffffff` | 主按钮文字颜色 |
| `--ws-danger` | `#a12540` | 删除/停用/报错文字与危险操作边框 |
| `--ws-brand` | `#9B1F58` | 仅用于 COLLINS Logo 与品牌标识 |
| `--ws-draft-bg` / `--ws-draft-text` | `#f5f1e6` / `#79714f` | 草稿 / 待审核状态徽标 |
| `--ws-success-bg` / `--ws-success-text` | `#edf6f0` / `#256842` | 已验证 / 已建索引 / 成功状态徽标 |
| `--ws-error-bg` / `--ws-error-border` | `#fdf7f8` / `#efd5da` | 错误提示条底色与边框 |

### 3.2 排版、圆角与布局 Token

| 变量名 | 桌面端 (`>700px`) | 移动端 (`<=700px`) | 用途 |
| --- | --- | --- | --- |
| `--ws-font` | `-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif` | 同左 | 全局字体栈 |
| `--ws-title-size` | `30px` | `26px` | 页面一级大标题 |
| `--ws-text-size` | `14px` | `13px` | 正文、输入框文字 |
| `--ws-header-height` | `64px` | `56px` | 顶部导航栏高度（不含安全区） |
| `--ws-page-gutter` | `42px` | `22px` | 页面左右内边距 |
| `--ws-content-width` | `1050px` | `100%` | 列表与管理页最大内容宽度 |
| `--ws-radius` | `10px` | `10px` | 输入框、卡片、标准按钮圆角 |
| `--ws-radius-sm` | `8px` | `8px` | 行内紧凑按钮圆角 |
| `--ws-radius-xs` | `5px` | `5px` | 状态徽标圆角 |
| `--ws-sheet-radius` | `0` | `20px` | 移动端底部抽屉顶部圆角 |

### 3.3 层级（`z-index`）规范

| 层级 | `z-index` | 用途 |
| --- | --- | --- |
| 顶部栏 / 吸顶工具栏 | `10` | `.subpage-header` / `.workspace-header` |
| 侧栏抽屉遮罩 / 侧栏 | `20` / `21` | 移动端 `.workspace-sidebar` |
| Sheet 遮罩 / Sheet 主体 | `40` / `41` | `.ws-overlay` / `.ws-sheet` |
| 二次确认弹窗 / Toast | `50` | 模态确认提示 |

## 4. 统一公共组件规范（`miniprogram/styles/workspace-components.wxss`）

建议将以下跨页面公共样式沉淀至 `miniprogram/styles/workspace-components.wxss`（由各页面按需 `@import`）：

### 4.1 轻量子页外框（`.subpage-shell`）

- 顶部导航栏（`.subpage-header`）：高度 `calc(var(--ws-safe-top, env(safe-area-inset-top)) + var(--ws-header-height))`，左侧固定 `‹ 返回` 按钮（Ghost 样式），中间/左侧展示页面标题，右侧可放 1 个主操作按钮或费用入口；移动端需避让微信小程序右上角胶囊按钮。
- 主内容区（`.subpage-body`）：居中容器 `max-width: var(--ws-content-width)`，左右内边距 `var(--ws-page-gutter)`，底部留白 `calc(36px + env(safe-area-inset-bottom))`，**无底部 4 Tab 栏**。

### 4.2 四级按钮体系（`.ws-btn`）

所有按钮必须清除微信默认边框（`button::after { border: 0; }`），最小触控高度 `44px`（列表行内紧凑操作按钮可设为 `34px–36px`），禁用态统一 `opacity: 0.45`：

| 级别 | Class | 视觉样式 | 使用场景 |
| --- | --- | --- | --- |
| Primary | `.ws-btn-primary` | 背景 `--ws-accent` (`#242424`)、文字 `--ws-on-accent` (`#ffffff`)、无边框 | 新建、上传、保存、发布、解锁、确认执行 |
| Secondary | `.ws-btn-secondary` | 背景 `--ws-canvas` (`#ffffff`)、文字 `--ws-text`、`1px solid var(--ws-border)` | 取消、导入、批量管理、回收站、试聊 |
| Ghost | `.ws-btn-ghost` | 透明背景、文字 `--ws-secondary`、无边框 | 顶部返回、行内「展开/收起」、关闭图标 |
| Danger | `.ws-btn-danger` | 透明背景（或 `1px solid var(--ws-error-border)`）、文字 `--ws-danger` | 删除、停用账号、彻底清理、移除引用 |

### 4.3 表单控件规范

- **统一左对齐**：所有 `input`、`textarea`、`.ws-picker` 文字必须**左对齐**（修复原 `accounts.wxss` 中异常的 `text-align: center`）。
- **边框与高度**：默认 `1px solid var(--ws-border)`、圆角 `var(--ws-radius)`、内边距 `0 12px`、最小高度 `44px`；聚焦态使用 `border-color: var(--ws-accent)`。
- **字段标签**：统一 `.ws-field-label`（字号 `12px`、颜色 `--ws-secondary`、字重 `500`、上边距 `18px`、下边距 `8px`）。

### 4.4 统一抽屉弹窗（`.ws-sheet`）

提炼自现有 `pages/home/home.wxss` 的 `.manage-sheet`，作为全站唯一的新建/编辑/移动/配置容器：

- **桌面端（`>700px`）**：`position: fixed; right: 0; top: 0; bottom: 0; width: 640px;`（统一固定宽度），左侧微阴影 `box-shadow: -8px 0 40px #00000012`。
- **移动端（`<=700px`）**：顶部避让安全区 `top: calc(var(--ws-safe-top, env(safe-area-inset-top)) + 48px)`，宽度 `100%`，顶部圆角 `var(--ws-sheet-radius) var(--ws-sheet-radius) 0 0`（`20px`）。
- **内部三段式结构**：
  1. `.ws-sheet-header`：左标题（`20px–21px` 字重 `600`）+ 副标题（`12px` `--ws-secondary`），右圆形关闭按钮（`32px × 32px`，`--ws-muted` 底）。
  2. `.ws-sheet-body`：`scroll-view` 垂直滚动，内边距左右 `28px`（移动端 `20px`）。
  3. `.ws-sheet-footer`：固定底栏，`1px solid var(--ws-border)` 顶边，底部适配 `env(safe-area-inset-bottom)`；左 `.ws-btn-secondary`（取消），右 `.ws-btn-primary`（保存/确认）。
- **动效**：入场动画 `workspace-enter 180ms ease-out`，必须响应 `@media (prefers-reduced-motion: reduce)` 关闭动画。

### 4.5 统一密码解锁门禁卡片（`.ws-gate-card`）

账号管理（`pages/accounts`）与 API/平台管理（`pages/admin`）共用同一套解锁视图：

- 居中容器 `max-width: 420px; margin: 48px auto 0;`
- `1px solid var(--ws-border)` 白色卡片，圆角 `var(--ws-radius)`，内边距 `24px`
- 标题（「管理员密码解锁」）+ 简短说明 + 密码输入框 + 全宽 `.ws-btn-primary` 解锁按钮 + `.ws-error-box` 错误提示。
- `pages/learning` 个人中心同步移除「平台管理员」徽标，并将原「API 管理」与「平台管理」合并为单一「平台与 API 管理」入口。

### 4.6 列表行、状态徽标与 AI 操作确认卡片

- **列表行（`.ws-list-row`）**：统一采用顶底 `1px solid var(--ws-border)` 细分割线，避免层层嵌套带圆角的重卡片；行内左图标/缩略图 + 中间标题与元信息 + 右侧状态或轻量操作区。
- **状态徽标（`.ws-badge`）**：字号 `10px–11px`、内边距 `3px 7px`、圆角 `var(--ws-radius-xs)`：
  - 默认/已发布：`--ws-muted` 底 + `--ws-secondary` 字
  - 草稿/待审核：`--ws-draft-bg` 底 + `--ws-draft-text` 字
  - 已索引/已验证：`--ws-success-bg` 底 + `--ws-success-text` 字
  - 已停用/删除/失败：`--ws-error-bg` 底 + `--ws-danger` 字
- **AI 操作确认卡片（`.ws-action-card`）**：教学资料管家与题库整理 AI 助手共用：
  - 背景 `--ws-sidebar`，边框 `1px solid var(--ws-border)`，圆角 `var(--ws-radius)`
  - 展示操作类型徽标、变更摘要/受影响条数、待确认/已执行/已取消状态
  - 底部右侧放「取消（`.ws-btn-secondary`）」与「确认执行（`.ws-btn-primary`）」。

### 4.7 原生微信交互 API 约定

小程序全站交互优先使用微信原生 API，禁止使用 Web 专属 API（如 `window.open`、`navigator.clipboard`、`<input type="file">`）：

- **安全区与胶囊避让**：使用 `wx.getWindowInfo()` 结合 `wx.getMenuButtonBoundingClientRect()` 计算顶部安全区与胶囊宽度，确保 `.subpage-header` 与 `.workspace-header` 不遮挡系统按钮。
- **操作菜单**：列表项「⋯」菜单统一使用 `wx.showActionSheet`，按当前用户权限动态生成菜单项。
- **危险操作二次确认**：删除文件/文件夹、彻底清理回收站、停用账号、删除题库题目/Agent 等操作统一使用 `wx.showModal`（`confirmColor: '#a12540'`）。
- **轻提示与加载态**：统一使用 `wx.showToast`、`wx.showLoading` / `wx.hideLoading`；复制注册码或链接统一使用 `wx.setClipboardData`。

## 5. 现有页面统一收口清单

| 页面 | 当前样式状态 | 第三期收口目标 |
| --- | --- | --- |
| `pages/accounts` | 独立 `accounts.wxss`，重边框、居中输入框、无统一返回栏、`480px/340px` 断点 | 迁入 `.subpage-shell` + `.ws-gate-card` + `.ws-sheet`（编辑显示名/重置密码/改注册码），完全移除硬编码色值 |
| `pages/admin` | 使用旧版 `.learning-page`、`900px` 断点、堆叠表单与多行灰块按钮 | 迁入 `.subpage-shell` + `.ws-gate-card` + `.ws-sheet`，按第 5.1 节重设计为简洁列表与统一测试/操作菜单 |
| `pages/studio` | 使用旧版 `.learning-page` | 升级为极简 Agent 预设管理中心（`.subpage-shell` 列表 + `.ws-sheet` 5 项极简编辑抽屉） |
| `pages/home` | 使用 `.workspace-shell`（误带底栏），内含优质 `.manage-sheet` | 迁入 `.subpage-shell`（去掉底栏，保留统一顶栏返回）；将 `.manage-sheet` 抽离为全站公共 `.ws-sheet` |
| `pages/learning`（资料 Tab） | 原为教师单按钮或学生平铺列表 | 在 `.workspace-shell` 内替换为网盘目录树列表 + 新建文件夹/重命名/移动/回收站 `.ws-sheet` |
| `pages/chat` | `.workspace-shell` | 保持 `.workspace-shell`，新增对 `.ws-action-card` 的统一样式支持 |
| `pages/login` / `pages/register` | 已引用 `workspace-tokens.wxss` | 保持现有简洁认证布局，确保 Logo 使用 `--ws-brand`、输入框聚焦态与全站一致 |

### 5.1 平台与 API 管理（`pages/admin`）重设计规范

针对当前 `pages/admin` 存在的文字粘连（`· 视觉 待验证创建助手：—`）、单卡下平铺 5 颗大灰块按钮、以及顶部堆叠大表单的问题，作如下重设计：

1. **页面结构（`.subpage-shell`）**：
   - 顶部栏：`‹ 返回` + `平台与 API 管理` + 右侧操作区（`＋ 添加模型` 主按钮、`价格配置` 次按钮、`平台费用` Ghost 按钮）。
   - 「添加模型」、「轮换密钥」、「新增价格版本」一律收进 `.ws-sheet` 抽屉，不在主列表上方堆叠大表单。
2. **模型列表行（`.ws-list-row`）三行清晰排版**：
   - **第 1 行**：左侧为「模型名称（`15px` 加粗）+ 状态徽标（`默认` / `可用` / `已停用`）」；右侧为紧凑型 `测试连接`（Secondary）与 `⋯`（`wx.showActionSheet`：设为默认模型、轮换密钥、停用/启用）。
   - **第 2 行**：独立成行的上游模型标识（如 `openai/gpt-6-luna`，`12px` `--ws-secondary`）。
   - **第 3 行**：三个独立小徽标（`文字 ✓/待测`、`工具 ✓/待测`、`视觉 ✓/待测`），间距 `6px`，禁止多段文本直接拼接。
3. **全模型默认带视觉能力与一键测试**：
   - **添加模型抽屉精简为 4 项**：显示名称、上游模型标识、API 地址（选填）、API 密钥；保存时默认写入 `capabilities: { text: true, tools: true, vision: true }`，不再展示「需要工具调用 / 需要视觉输入」开关。
   - **存量模型兼容**：读取与校验模型时默认视 `vision = true`；点击「测试连接」一键顺序探测 `text` + `tools` + `vision` 并更新验证结果。
   - **单一默认模型动作**：菜单中点击「设为默认模型」，同步写入 `kl_settings` 的 `defaultChatModelId`、`builderModelId` 与 `visionModelId`，无需让教师分别设置三个槽位。

## 6. UI 一致性验收案例（`UI-*`）

| 编号 | 验收场景 | 预期结果 |
| --- | --- | --- |
| UI-01 | Token 唯一性检查 | 第三期新增与收口页面的 `.wxss` 中不存在硬编码旧色值（如 `#81838a`、`#55565b`）或非 `700px` 的自定义媒体查询断点。 |
| UI-02 | 两套外框边界清晰 | 仅聊天/题库/资料/我的（及会话/详情）显示底部 4 Tab 栏；账号管理、平台管理、Agent 预设管理、题库管理均使用统一顶栏返回且无底栏。 |
| UI-03 | 抽屉弹窗跨端一致 | 新建文件夹、编辑题目、编辑账号、新增模型、编辑 Agent 预设均通过 `.ws-sheet` 完成；桌面端（`>700px`）右侧滑出，移动端（`<=700px`）底部圆角弹出且不跳页。 |
| UI-04 | 密码解锁门禁一致 | `pages/accounts` 与 `pages/admin` 的未解锁态呈现完全一致的 `.ws-gate-card` 视觉结构与错误反馈。 |
| UI-05 | 表单控件一致性 | 所有页面输入框与选择器文字均左对齐、统一 `1px solid var(--ws-border)` 细边框、`44px` 最小触控高度与 `--ws-accent` 聚焦态。 |
| UI-06 | 四级按钮与状态徽标一致 | 主按钮统一 `#242424` 白字、次按钮白底细边框、危险操作仅文字/细边框用 `--ws-danger`；状态徽标跨页样式统一。 |
| UI-07 | AI 操作确认卡片一致 | 题库整理助手与资料管家发出的确认卡片在布局、状态徽标与确认/取消按钮层级上完全一致。 |
| UI-08 | 安全区与防遮挡 | 微信真机（含刘海屏/底部 Home Indicator）与桌面端下，顶栏返回按钮不被右上角胶囊遮挡，Sheet 底部按钮不被系统手势条遮挡。 |
