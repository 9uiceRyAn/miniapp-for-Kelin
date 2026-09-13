# Functional and server audit

Last infrastructure audit: **2026-09-07**  
Repository handoff baseline: **v0.1 / 2026-09-13**

## 1. Production infrastructure verified

在生产服务器实际执行过检查：

- Ubuntu 24.04.4 LTS
- Node.js 22.23.2
- npm 10.9.8
- MySQL 8.0.46
- Nginx 1.24.0
- PM2 process `file-manager-api` online
- Nginx / MySQL / PM2 startup service active
- Certbot timer active
- `nginx -t` passes
- Public ports: 80 / 443
- Express only listens on `127.0.0.1:3000`
- MySQL only listens on `127.0.0.1:3306`
- Local `/api/health` succeeds
- Public `https://api.kelinliuxue.com/api/health` succeeds
- Database connection succeeds

当时生产文件表记录数和服务器实际文件数量按 count 核对一致。

## 2. Application features verified

### Authentication / account

- Login
- Registration
- Teacher / student role split
- Remember username
- Remember device
- Auto-login
- Session expiration handling
- Logout
- Display name

### Files

- A–E category switching
- Category counts
- Current-category file search
- Teacher upload
- Multi-file upload + progress
- Desktop file selection
- Mobile album media selection
- Mobile camera capture
- Mobile WeChat-chat file selection
- Single-file download / preview / share
- Category ZIP export
- Teacher delete
- Student upload/delete restrictions
- Uploader display name
- Beijing-time upload-time display

### Personal marks

- Mark file
- Query marks
- Unmark file
- Mark persistence in MySQL
- Hide marked files
- Search + hide-marked combination
- Per-user isolation by schema/API design

## 3. Personal mark feature production verification

`user_file_marks` 已部署到生产 MySQL。

真实登录 token 下完成过：

```text
PUT    /api/marks/:fileId      -> marked=true
GET    /api/marks?category=A   -> returned marked file id
DELETE /api/marks/:fileId      -> marked=false
```

同时在 MySQL 中确认标记 row 创建成功，取消标记后 row 删除成功。

真实微信开发者工具 / 手机端也完成 checkbox、隐藏已标记、重新进入后状态等功能验证。

## 4. Bugs fixed before v0.1

### Remembered-device logout

旧前端虽然调用 `api.logout(rememberToken)`，但旧 API wrapper 没有真正发送 remember token；旧 backend logout 只清理当前 session。

v0.1：

- 前端向 logout 发送 remember token。
- backend logout 可处理 session token 和 remember token。
- 当前设备 remember token 可被撤销。

### Fast category-switch race

旧文件列表请求可能在用户已经切换分类后才返回，导致旧分类结果覆盖当前分类。

v0.1 会忽略 stale list response。

### Upload category race

旧多文件上传过程中如果用户切换分类，后续文件可能上传到不同分类。

v0.1 在开始上传时锁定分类，并在上传期间阻止分类切换。

### Duplicate registration race

并发注册同名用户可能直接触发 DB unique constraint 并返回 generic 500。

v0.1 将 `ER_DUP_ENTRY` 映射为 409 / 用户名已存在语义。

### Registration field-length mismatch

前后端字段长度已对齐。

### UI cleanup

- 文件内部自增 ID 不再显示给用户，但数据库 ID 保留。
- 上传者显示注册 `display_name`。
- ISO / UTC 时间由前端统一转换为北京时间 + AM/PM。
- 上传入口去掉无意义的 PDF / PPT / Word 等重复子分类。

## 5. Current database tables

```text
users
files
auth_sessions
remember_devices
user_file_marks
```

`user_file_marks`：

```text
UNIQUE(user_id, file_id)
user_id -> users(id) ON DELETE CASCADE
file_id -> files(id) ON DELETE CASCADE
```

## 6. Security posture verified

- Production `.env` is not part of the repository.
- Passwords are hashed, not stored as plaintext.
- Session and remember tokens are hashed in DB.
- Express is not directly exposed to the public network.
- MySQL is not directly exposed to the public network.
- HTTPS terminates at Nginx.
- Teacher-only mutations are protected by role middleware.

## 7. Known non-blocking technical debt

### Expired auth record cleanup

Expired `auth_sessions` and expired/revoked `remember_devices` are ignored by authentication queries but are not automatically purged.

Future options:

- daily cleanup cron / scheduled job
- opportunistic cleanup during login

### Rate limiting

Login / register / remember-login do not currently have request throttling.

Before large public rollout, add rate limiting at Nginx or Express level.

### Server-side search and pagination

Current files API returns a complete category; front-end performs search/filter locally.

This is appropriate for the current small library. If categories grow to thousands of files or metadata becomes rich, move search / pagination to backend.

### Upload file type policy

Backend currently prioritizes flexibility for teaching resources. It has a file-size limit but does not implement a strict MIME/extension allow-list.

If the product becomes broadly public, add a server-side allow-list / content policy.

### Mobile system file browser

v0.1 does not implement direct iOS Files / Android document-picker browsing from the Mini Program. Current mobile upload sources are album, camera, and WeChat chat files.

### Automated test coverage

Current `npm test` is syntax validation. Critical flows were tested manually. Later maintainers should add unit/integration/CI coverage before major expansion.

## 8. Final v0.1 readiness

At handoff, the core file-management workflow and personal mark feature have been deployed and manually verified.

The next development phase can focus on classification / metadata / search / AI without first rewriting the stable v0.1 foundation.
