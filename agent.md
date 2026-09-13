# AI / Coding Agent Context — miniapp for Kelin

本文件用于后续 AI coding agent、IDE agent 或新开发者快速理解项目。**v0.1 是已经人工验证过的稳定交接基线。** 在没有明确需求时，不要为了“重构”而改变现有业务行为。

## 1. 项目目标

这是一个可林留学内部资料管理微信小程序。当前版本解决：

- 教师 / 学生账号与权限
- A–E 资料分类
- 文件上传、下载、预览、删除、ZIP 导出
- 当前分类搜索
- 每个用户独立的文件标记 / 隐藏已标记
- desktop / mobile UI
- 自建 Node.js / Express / MySQL 后端

未来预计扩展：metadata/tag 分类、搜索引擎、AI Chatbot / RAG。

## 2. 重要原则

### MUST NOT

1. **不要重新引入 wx.cloud / CloudBase。** 当前生产架构已经完全迁移到自建 API。
2. **不要提交任何生产 secret。** 包括 `.env`、注册 code、数据库密码、token、数据库 dump。
3. **不要把用户上传文件提交到 Git。** 上传文件保存在服务器文件系统。
4. **不要删除数据库内部 file id。** UI 不显示编号，但 `files.id` 是下载、删除、marks 外键等内部关系的关键主键。
5. **不要把个人 marks 变成共享文件属性。** 标记必须始终以 `user_id + file_id` 隔离。
6. **不要覆盖生产 `.env`。** 部署新 backend 时保留服务器已有 `.env`。
7. 未经明确需求，不要改变 v0.1 已确认的 UI 文案、品牌色或权限规则。

### SHOULD

- 改动 API 时尽量保持向后兼容。
- 数据库 schema 变化通过 `database/migrations/` 增量 migration 完成。
- 写操作必须继续使用认证 / 角色 middleware。
- 删除文件或用户时保持 marks 级联清理。
- 任何生产部署前先备份 backend 和数据库。

## 3. 架构

```text
WeChat Mini Program
  miniprogram/
       ↓ HTTPS
https://api.kelinliuxue.com
       ↓
Nginx
       ↓
Express / Node.js / PM2
127.0.0.1:3000
       ↓
MySQL + filesystem uploads
```

生产后端目录：

```text
/var/www/file-manager/backend
```

生产上传目录：

```text
/var/www/file-manager/uploads/files
```

PM2 app：

```text
file-manager-api
```

## 4. Backend 入口与核心文件

```text
backend/src/server.js
backend/src/db.js
backend/src/middleware/auth.js
backend/src/routes/auth.js
backend/src/routes/files.js
backend/src/routes/marks.js
backend/src/utils/security.js
```

### API groups

```text
GET /api/health

POST /api/auth/register
POST /api/auth/login
GET  /api/auth/me
POST /api/auth/logout
POST /api/auth/remember-login

GET    /api/files/counts
GET    /api/files?category=A
POST   /api/files/upload
GET    /api/files/export/:category
GET    /api/files/:id
GET    /api/files/:id/download
DELETE /api/files/:id

GET    /api/marks?category=A
PUT    /api/marks/:fileId
DELETE /api/marks/:fileId
```

上传与删除只允许 teacher。

## 5. Authentication

- 密码不是明文存储；使用 `backend/src/utils/security.js` 中的 PBKDF2 hash。
- Session token 在数据库中保存 hash。
- remember-device token 在数据库中保存 hash。
- `requireAuth` 从 `Authorization: Bearer <token>` 获取 token。
- logout 会同时撤销当前 session 和传入的 remember token。
- 不要把 token 写入日志或文档。

主要表：

```text
users
auth_sessions
remember_devices
```

## 6. Files

`files` 表是真实文件的数据库索引；文件 bytes 存在服务器文件系统，而不是 MySQL BLOB。

主要概念：

```text
files.id              internal primary key; UI intentionally hides it
files.category        A / B / C / D / E
files.original_name   user-visible filename
files.storage_path    server-side physical path
files.uploader_id     uploader relation
files.created_at      upload timestamp
```

文件列表通过 users relation 返回上传者显示名 `uploader_name`，前端显示用户注册时填写的 `display_name`。

### Time display

后端时间可返回 ISO / UTC。前端 `miniprogram/utils/file.js` 将导入时间统一展示为：

```text
Beijing time (UTC+8), 12-hour clock + AM/PM
```

不要通过修改数据库时间来“修正”显示时区。

## 7. Personal marks

表：

```text
user_file_marks
```

约束：

```text
UNIQUE(user_id, file_id)
```

外键：

```text
user_id -> users(id) ON DELETE CASCADE
file_id -> files(id) ON DELETE CASCADE
```

前端 checkbox 只是用户个人状态，不是文件公共状态。

“隐藏已标记”与搜索过滤可以同时使用。

## 8. Mini Program frontend

主要页面：

```text
miniprogram/pages/login/
miniprogram/pages/register/
miniprogram/pages/home/
```

API wrapper：

```text
miniprogram/utils/api.js
```

Local storage / session：

```text
miniprogram/utils/storage.js
```

文件格式化：

```text
miniprogram/utils/file.js
```

API base URL：

```text
miniprogram/config/api.js
```

当前为：

```text
https://api.kelinliuxue.com
```

## 9. Upload behavior — v0.1

### Desktop

“导入文件”直接进入一个文件选择入口，不再按 PDF / PPT / Word / Excel 等人为拆分。

### Mobile

当前只提供：

1. 相册图片或视频
2. 拍照或录像
3. 微信聊天文件

**系统 Files / Downloads 任意本地文件浏览器没有实现。**

注意：`home.js` 内仍有旧注释提到“手机文件下一步接入”，但实际 v0.1 产品决策是暂不实现。不要仅因为这条注释就自行增加 web-view / H5 上传页。

## 10. Final v0.1 UI decisions

当前 UI 已经过人工确认，不是临时 mockup。

- COLLINS 主品牌色：`#9B1F58`
- 使用 `miniprogram/images/collins-logo.png`
- 登录页 Hero：`归档 · 检索 · 标记`
- 首页 Hero：`熟能生巧。`
- 首页不显示四个统计 summary cards
- 文件自增编号不展示给用户
- 文件列表显示上传者与北京时间
- A–E 横向分类浏览
- 搜索、marks、hide marked 保留

若后续要增加 metadata / AI UI，应在此设计系统上扩展，而不是重新复制 Question Atlas 等外部页面。

## 11. Database migrations

现有 migration：

```text
database/migrations/001_user_file_marks.sql
```

新 schema 变更请继续使用有序 migration，例如：

```text
002_file_tags.sql
003_search_indexes.sql
```

不要直接修改生产数据库后不留下 migration。

## 12. Validation before commit

Backend：

```bash
cd backend
npm test
```

检查 secret：

```bash
git status
grep -RInE '^(DB_PASSWORD|TEACHER_REGISTER_CODE|STUDENT_REGISTER_CODE)=' . --exclude='.env.example' --exclude-dir='.git' || true
```

确认以下文件没有进入 commit：

```text
backend/.env
project.private.config.json
uploads/
node_modules/
*.sql production dumps
```

Mini Program 改动还应在微信开发者工具完成：

- compile
- desktop preview
- real-device preview / 真机调试

## 13. Production validation after deploy

至少检查：

```text
/api/health
login
remember login
logout
A–E switching
file list/search
teacher upload/delete
student permissions
download
ZIP export
mark / unmark
hide marked
```

详细步骤见 `docs/DEPLOY.md`。

## 14. Known technical debt / future options

不是 v0.1 blocker：

- auth rate limiting
- expired session cleanup
- server-side search / pagination
- stricter upload allow-list
- metadata + tag schema
- full-text / search engine integration
- AI Chatbot / RAG
- CI / automated integration tests
- mobile system file browser

## 15. Handoff rule

如果需求是“加分类 / 搜索 / AI”，优先扩展数据层和 API，不要破坏当前稳定的文件管理、用户权限、marks 与 UI 基线。
