# Production deployment and verification

本文档供后续维护者重新部署或更新 production 使用。v0.1 已经部署并验证；以下步骤不是要求每次都全部执行，而是标准安全流程。

## Production layout

```text
/var/www/file-manager/backend
/var/www/file-manager/uploads/files
```

PM2 process：

```text
file-manager-api
```

Public API：

```text
https://api.kelinliuxue.com
```

Node listens on：

```text
127.0.0.1:3000
```

## 1. Before deployment: inspect and back up

```bash
STAMP=$(date +%Y%m%d_%H%M%S)

cd /var/www/file-manager

tar \
  --exclude='backend/node_modules' \
  --exclude='backend/.env' \
  --exclude='uploads' \
  -czf "/home/ubuntu/file-manager-backend-${STAMP}.tar.gz" \
  backend

sudo mysqldump file_manager \
  > "/home/ubuntu/file_manager-${STAMP}.sql"

ls -lh \
  "/home/ubuntu/file-manager-backend-${STAMP}.tar.gz" \
  "/home/ubuntu/file_manager-${STAMP}.sql"
```

生产上传文件非常重要，不要在部署过程中删除 `/var/www/file-manager/uploads`。

## 2. Preserve production environment

生产配置位于：

```text
/var/www/file-manager/backend/.env
```

**不要用仓库的 `.env.example` 覆盖它。**

仓库只提供字段模板：

```text
backend/.env.example
```

学习平台需要 Node.js 22.13 或更高版本。模型和网关配置、样本导入见 [完整应用开发与联调](specs/02-complete-implementation.md)。生产部署继续保留原有环境配置与上传文件。

## 3. Database migrations

现有 marks migration：

```bash
sudo mysql file_manager \
  < database/migrations/001_user_file_marks.sql
```

验证：

```bash
sudo mysql file_manager -e "SHOW TABLES;"
sudo mysql file_manager -e "SHOW CREATE TABLE user_file_marks\G"
```

该 migration 使用 `CREATE TABLE IF NOT EXISTS`，生产当前已经存在这张表。

以后新增 schema 应创建新的 migration，不要覆盖 `001_user_file_marks.sql`。

学习平台还需要 002_learning_platform.sql。将整个 database/migrations/ 同步到服务器项目根目录，保证它与 backend/ 同级，然后在 backend 目录执行 npm run migrate。该命令按顺序应用并记录迁移；先完成本节的数据库备份。

## 4. Backend validation before restart

在准备部署的 repository：

```bash
cd backend
npm ci
npm run build
npm test
```

如果服务器已有正确 `node_modules` 且依赖没有变化，可不重复安装；如果 `package-lock.json` 或依赖变化，使用 `npm ci`。

## 5. Deploy backend

建议使用 rsync / scp 更新源码，但明确排除：

```text
.env
node_modules/
uploads/
```

例如从本地项目根目录：

```bash
rsync -av \
  --exclude '.env' \
  --exclude 'node_modules' \
  --exclude '.local' \
  --exclude 'uploads' \
  --exclude 'sample-data' \
  --exclude 'dist' \
  backend/ \
  ubuntu@YOUR_SERVER:/var/www/file-manager/backend/
```

迁移文件也要同步：

```bash
rsync -av database/migrations/ ubuntu@YOUR_SERVER:/var/www/file-manager/database/migrations/
```

如果只更新少数文件，也可以精确 `scp` 对应文件。

## 6. Restart PM2

服务器：

```bash
cd /var/www/file-manager/backend

npm ci
npm run migrate
npm run build
npm test
pm2 restart file-manager-api
pm2 status
pm2 logs file-manager-api --lines 50 --nostream
```

PM2 直接启动 server.js 时不会触发 npm prestart，所以部署时必须显式运行 build，生成 dist/agent/engine.mjs。普通 npm test 执行静态与单元检查；MySQL 集成测试仅在独立本地测试库运行，不在生产指定 TEST_MYSQL_PORT。

正常状态：

```text
file-manager-api   online
```

如果有环境变量字段变化：

```bash
pm2 restart file-manager-api --update-env
```

只在你确认 `.env` 已正确更新时使用。

## 7. Health check

```bash
curl -sS http://127.0.0.1:3000/api/health
curl -sS https://api.kelinliuxue.com/api/health
```

应返回：

```text
success=true
status=ok
database=connected
```

## 8. Functional smoke test

使用真实 teacher / student 测试账号验证：

### Auth

- Login
- Remember-device auto-login
- Logout
- Re-login

### File library

- A–E 分类切换
- 文件数量
- 搜索
- Teacher upload
- Student 无 upload / delete 权限
- 单文件下载 / 预览
- 分类 ZIP 导出
- Teacher delete 测试文件

### Marks

- 勾选一个文件
- 离开分类再返回，标记仍在
- 重新登录后，标记仍在
- 打开“隐藏已标记”，文件消失
- 关闭后文件重新出现且 checkbox 保持
- 取消标记

### Learning workspace

- 题库学科、标签、媒体与修订读取。
- 教学助手对话、工具调用、费用记录与教师/学生权限。
- 教学资料管家查询 A–E 文件，准备新增/索引/替换/撤下卡片，确认后检查实际资料状态。
- 改变默认创建助手模型后，新资料管家会话使用新模型，旧记录仍能读取。

## 9. API-level marks test (optional)

不要把真实 token 粘到聊天、日志或 commit。

```bash
curl -sS \
  "https://api.kelinliuxue.com/api/marks?category=A" \
  -H "Authorization: Bearer ${TEST_TOKEN}"
```

数据库：

```bash
sudo mysql file_manager -e "
SELECT user_id, file_id, marked_at
FROM user_file_marks
ORDER BY marked_at DESC
LIMIT 20;
"
```

## 10. Nginx / port checks

```bash
sudo nginx -t
sudo ss -lntp | grep -E ':80 |:443 |:3000 |:3306 ' || true
```

预期：

- Nginx: 80 / 443 public
- Express: `127.0.0.1:3000`
- MySQL: `127.0.0.1:3306`

## 11. Rollback

如果新 backend 启动失败：

1. 停止或不要反复 restart 出错版本。
2. 从部署前 tar.gz 恢复 backend 源码。
3. 保留当前 production `.env`。
4. 如 migration 造成问题，再根据该 migration 的实际影响恢复数据库 backup。
5. `pm2 restart file-manager-api`。
6. 重跑 health check。

不要在没有确认的情况下删除 uploads。

## 12. GitHub safety before production deploy

```bash
git status
git log -1 --oneline
git tag --points-at HEAD
```

建议生产部署来自明确的 release/tag，而不是来源不明的本地未提交代码。
