# miniapp for Kelin

> 可林留学资料库微信小程序 · v0.1

用于个人学习与内部资料管理的微信小程序。当前版本已经完成基础文件管理、教师/学生权限、设备记忆登录、个人文件标记、搜索与响应式 UI，并已从微信云开发迁移到自建 **Express + MySQL + Nginx + PM2** 架构。

**当前交接状态：v0.1 可运行基线。** 后续的题库分类、metadata/tag 搜索、搜索引擎和 AI Chatbot 功能由后续开发者在此版本上继续扩展。

## 架构

```text
WeChat Mini Program
        ↓ HTTPS
https://api.kelinliuxue.com
        ↓
Nginx
        ↓
Express / Node.js / PM2
127.0.0.1:3000
        ↓
MySQL + server-side file storage
```

生产环境当前采用：

- Ubuntu 24.04 LTS
- Node.js 22
- MySQL 8
- Nginx 1.24
- PM2
- HTTPS / Certbot

> 本仓库不包含生产环境密码、注册码、数据库 dump 或用户上传文件。

## v0.1 已完成功能

### 账号与权限

- 教师 / 学生注册与登录
- 教师 / 学生角色权限分离
- 记住用户名
- 记住设备并自动登录
- Session 登录状态验证
- 退出登录同时撤销当前 Session 与当前设备 remember token
- 注册显示名 `display_name`，文件列表显示上传者名称

### 文件管理

- A–E 五个资料分类
- 各分类文件数量统计
- 当前分类文件名 / 关键词搜索
- 教师上传文件
- 多文件上传与上传进度
- 教师删除文件
- 单文件下载 / 预览 / 分享
- 整个分类 ZIP 导出
- 桌面端与手机端响应式布局

当前上传入口：

- **桌面端**：点击“导入文件”后直接选择本地文件，不再按 PDF / PPT / Word 等类型拆分入口。
- **手机端**：相册图片或视频、拍照或录像、微信聊天文件。
- **未实现**：微信小程序内直接浏览 iOS Files / Android 系统文件管理器中的任意本地文件。此项属于后续可选功能，不影响当前 v0.1。

### 个人文件标记

每个账号可以独立标记文件，不影响其他用户：

- 标记 / 取消标记文件
- 标记状态保存在 MySQL
- 换设备或重新登录后仍然保留
- 搜索结果中显示个人标记状态
- 可选择“隐藏已标记”
- 搜索与隐藏已标记可组合使用

数据库表：

```text
user_file_marks
├── id
├── user_id
├── file_id
└── marked_at
```

其中 `(user_id, file_id)` 唯一；用户或文件删除时，对应标记通过外键 `ON DELETE CASCADE` 自动清除。

## UI / 品牌

v0.1 已完成 COLLINS 品牌视觉整理：

- 主品牌色：`#9B1F58`
- 低饱和暖灰背景
- 编辑型衬线大标题 + 系统无衬线正文
- COLLINS Cambridge International Centre Logo
- 首页采用顶部品牌区、简洁 Hero、横向分类浏览、搜索与资料列表
- 登录页采用“归档 · 检索 · 标记”信息结构
- 首页 Hero 使用“熟能生巧。”
- 不再展示无业务意义的文件自增 ID
- 导入时间统一以北京时间 UTC+8 + AM/PM 格式显示

详见 [`docs/UI_REDESIGN.md`](docs/UI_REDESIGN.md)。

## Repository layout

```text
backend/                         Express API
├── src/
│   ├── middleware/auth.js
│   ├── routes/auth.js
│   ├── routes/files.js
│   ├── routes/marks.js
│   ├── utils/security.js
│   ├── db.js
│   └── server.js
├── .env.example
├── ecosystem.config.js
└── package.json

miniprogram/                     微信小程序前端
├── config/api.js
├── images/collins-logo.png
├── pages/
│   ├── login/
│   ├── register/
│   └── home/
└── utils/

database/migrations/            数据库增量脚本
docs/                           审计、部署、GitHub、UI 文档
i18n/                           项目资源
project.config.json              微信开发者工具项目配置
project.private.config.json.example
agent.md                         给 AI / coding agent 的项目上下文
```

## 后端 API

### Health

```text
GET /api/health
```

### Auth

```text
POST /api/auth/register
POST /api/auth/login
GET  /api/auth/me
POST /api/auth/logout
POST /api/auth/remember-login
```

### Files

```text
GET    /api/files/counts
GET    /api/files?category=A
POST   /api/files/upload                 teacher only
GET    /api/files/export/:category
GET    /api/files/:id
GET    /api/files/:id/download
DELETE /api/files/:id                    teacher only
```

### Personal marks

```text
GET    /api/marks?category=A
PUT    /api/marks/:fileId
DELETE /api/marks/:fileId
```

除 health、login、register、remember-login 等认证入口外，业务 API 使用 Bearer token。

## 本地打开小程序

1. 安装微信开发者工具。
2. 导入仓库根目录，而不是单独导入 `miniprogram/`。
3. `project.config.json` 已配置 `miniprogramRoot`。
4. 如需本机私有开发者工具配置，可复制：

```bash
cp project.private.config.json.example project.private.config.json
```

`project.private.config.json` 已被 `.gitignore` 排除，不应提交。

小程序 API 地址位于：

```text
miniprogram/config/api.js
```

当前生产 API：

```text
https://api.kelinliuxue.com
```

## Backend 本地检查

```bash
cd backend
npm install
npm test
```

`npm test` 当前执行静态语法检查，不会连接或修改生产数据库。

如果需要本地运行后端：

```bash
cp .env.example .env
# 填入本地开发环境配置
npm start
```

不要将真实 `.env` 提交到 Git。

## 数据库

当前业务涉及的主要表：

```text
users
auth_sessions
remember_devices
files
user_file_marks
```

个人标记 migration：

```bash
mysql file_manager < database/migrations/001_user_file_marks.sql
```

该 migration 使用 `CREATE TABLE IF NOT EXISTS`，可安全用于确认表存在，但生产操作前仍应先备份数据库。

## 生产部署

当前生产目录约定：

```text
/var/www/file-manager/backend
/var/www/file-manager/uploads/files
```

PM2 process：

```text
file-manager-api
```

详细部署、备份、验证与回滚步骤见：

- [`docs/DEPLOY.md`](docs/DEPLOY.md)
- [`docs/AUDIT.md`](docs/AUDIT.md)

## Security / 不要提交

以下内容禁止进入 GitHub：

```text
backend/.env
project.private.config.json
node_modules/
uploads/
数据库生产 dump
真实数据库密码
教师 / 学生注册码
任何真实用户 token
```

仓库中的 `backend/.env.example` 只包含占位值。

推送前建议：

```bash
git status
grep -RInE '^(DB_PASSWORD|TEACHER_REGISTER_CODE|STUDENT_REGISTER_CODE)=' . --exclude='.env.example' --exclude-dir='.git' || true
```

第二条命令正常情况下不应返回任何结果；如果返回，先确认是否误把真实 `.env` 或 secret 文件放进了项目。

## 当前已知的后续工作

v0.1 不要求解决，交给后续开发者按需求推进：

- metadata / tag 驱动的资料分类
- 跨分类、跨标签的 server-side 搜索
- 文件列表分页
- AI Chatbot / RAG
- 登录 / 注册接口 rate limiting
- 过期 session 与 remember-device 定期清理
- 更严格的上传文件类型策略（如需要）
- 手机系统文件浏览上传（如需要）
- 自动化 CI / test coverage

扩展前请先阅读 [`agent.md`](agent.md)，其中记录了当前代码契约、生产环境约束和不能轻易破坏的行为。

## 文档

- [`docs/AUDIT.md`](docs/AUDIT.md) — 当前功能、服务器与已知技术债审计
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — 生产部署 / 验证 / 回滚
- [`docs/GITHUB.md`](docs/GITHUB.md) — 首次发布、v0.1 tag / release、协作者权限
- [`docs/UI_REDESIGN.md`](docs/UI_REDESIGN.md) — 最终 UI 与品牌设计说明
- [`agent.md`](agent.md) — AI / coding agent 项目上下文与约束

## Version

当前交接版本：

```text
v0.1
```

建议将此版本作为后续分类、搜索和 AI 功能开发的稳定基线。
