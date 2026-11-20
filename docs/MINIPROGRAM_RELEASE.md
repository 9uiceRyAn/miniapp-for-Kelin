# 微信小程序教师管理发布手册

管理员按 **确定发布版本 → 更新后端 → 真机验收体验版 → 提审并发布** 的顺序操作。教师管理位于小程序「我的 → 教师管理」，普通教师可使用。账号停用、密码重置和注册码轮换均会影响真实用户，功能验收请使用专用测试账号。

## 本次发布交接（2026-11-20）

**生产题库已经就位，本次账号功能发布无需重新导入题库。** 当日以正式源 `question_bank_database_v1/metadata/items.json` 为基准，逐题比对生产库中的当前修订，并从服务器读取媒体文件计算 SHA-256。

| 生产数据 | 核验结果 |
| --- | --- |
| 题目 | 9 个学科、11 个题集，共 9,934 道。全部当前修订哈希一致，缺失、多余、重复均为 0。 |
| 小程序「仅看可用」 | 9,584 道符合条件（`quality_status=ready` 且 `review_required=0`）。其余 350 道已入库，其中 263 道待复核，87 道标记为 `unclassified_coding`。 |
| 题目媒体 | 20,786 条引用对应 12,263 个不同内容的文件。引用的路径、类型及文件 SHA-256 全部匹配。 |

更新后端时，备份并沿用现有生产数据库、用户上传目录 `/var/www/file-manager/uploads/files` 和题库媒体所在的 `/var/www/file-manager/uploads/learning`。远端隔离测试使用的合成题库仅供测试。

**后端已完成的改动与验证。** 功能提交 `37f9717` 保留了小程序微信登录、已有账号绑定和凭码注册。教师管理 API 使用小程序会话校验教师身份，支持账号管理和注册码轮换。密码重置会撤销旧会话和已记住的设备凭证，并修复了与重置并发的旧密码登录仍可取得有效会话的问题。独立网页账号页、扫码登录及回调路由已移除。

该提交在远端临时目录完成依赖安装和构建，并在独立 MySQL 实例通过 46/46 项测试，零跳过。测试覆盖旧网页返回 404、小程序登录和绑定、教师可访问管理接口、学生访问返回 403。微信服务响应由测试模拟，真实微信授权按第 3 节验收。临时目录和数据库实例已清理。

**生产仍待执行。** 本轮验证未切换生产 API、运行生产迁移或重启 PM2。当日匿名实测，`/api/health` 返回 200 且数据库已连接，`/api/auth/wechat/config` 和 `/api/teacher-admin/users` 均返回 404。管理员应先按第 2 节部署后端、核对密钥、执行迁移并初始化注册码；待微信配置接口返回 200 且 `data.mini=true`、匿名教师管理请求返回 401 后，再上传小程序体验版。

## 1. 确定可以发布的版本

管理员应从同一个发布 SHA 构建小程序和后端，核对该版本包含小程序微信登录、教师管理入口和数据库迁移。

从该 SHA 建立干净的发布目录。在项目根目录运行以下 PowerShell 检查，记录实际 SHA。任何一项失败，都先补齐候选版本再继续。

```powershell
git rev-parse HEAD
if (git status --porcelain) { throw '发布目录存在未提交文件' }
$required = @(
  'miniprogram/pages/accounts/accounts.wxml', 'miniprogram/utils/input-hints.js',
  'miniprogram/utils/wechat.js', 'backend/src/routes/teacher-admin.js',
  'backend/src/routes/wechat.js', 'backend/src/registration-codes.js',
  'backend/scripts/init-registration-codes.js',
  'database/migrations/003_wechat_identity.sql', 'database/migrations/004_teacher_accounts.sql'
)
git ls-files --error-unmatch -- $required
if ($LASTEXITCODE) { throw '发布版本缺少必要文件' }
if ('pages/accounts/accounts' -notin (Get-Content -Raw miniprogram/app.json | ConvertFrom-Json).pages) {
  throw '教师管理页面尚未注册'
}
```

在干净副本构建后端并编译小程序。使用项目要求的 Node.js 22.13 或更高版本。在隔离环境运行 `npm ci`、`npm run build` 及 `npm test`，从 `backend/` 执行。真库测试需要将 `TEST_MYSQL_PORT` 指向专用测试 MySQL；测试会建库和删库。记录失败与跳过项，尤其核对密码重置并发回归。此前的工作区测试结果不能替代对最终 SHA 的测试。

## 2. 更新生产 API

1. 在生产机记录上一版后端 SHA 或可恢复的代码包、当前小程序线上版本、PM2 状态。按照[生产部署手册](DEPLOY.md)备份后端和 MySQL，并确认备份可读。单独安全备份生产 `.env` 和已有密钥。保留 `/var/www/file-manager/uploads` 及学习资料存储目录。
2. 把候选版本的 `backend/` 和同级 `database/migrations/` 放到服务器。在独立候选目录的 `backend/` 中运行 `npm ci --include=dev && npm run build`，确认 `dist/agent/engine.mjs` 存在。切换时沿用生产 `/var/www/file-manager/backend/.env`、存储路径、文件权限和 PM2 进程名 `file-manager-api`。本地体验项目、测试数据库和测试账号均不随包发布。
3. 在生产密钥配置中核对 `REGISTRATION_CODE_KEY`，格式为 **32 个随机字节编码成的 64 位十六进制值**。首次配置时生成一次，后续发布和所有实例沿用同一个值，已有加密注册码依赖它。微信快捷登录另需 `WECHAT_MINI_APP_ID` 和 `WECHAT_MINI_APP_SECRET`，AppID 须与发布项目一致。核对现有数据库和存储环境变量；生产进程不设置 `TEST_MYSQL_PORT`。
4. 在维护窗口，将已构建的候选版本就位。确认 shell 使用预期的生产配置，再在服务器执行以下命令。每步成功才继续。

```bash
cd /var/www/file-manager/backend
(
  set -e
  test -f dist/agent/engine.mjs
  node -e "require('dotenv').config(); if (!/^[0-9a-f]{64}$/i.test(process.env.REGISTRATION_CODE_KEY || '')) process.exit(1)"
  npm run migrate
  node scripts/init-registration-codes.js
  pm2 restart file-manager-api --update-env
  pm2 status file-manager-api
)
```

迁移命令按顺序执行并登记在 `kl_migrations`。003 创建微信身份相关表，004 创建注册码表和账号管理锁。初始化会补齐教师、学生两条注册码，保留已有值。新版注册开始使用数据库中的码；管理员应通过教师账号在小程序内查看并交付给对应人员。

在生产数据库执行以下只读查询，确认两项迁移均有记录，而且 `teacher`、`student` 各有一行。再用已有教师账号实际打开注册码页，确认密钥能读取现有数据。

```sql
SELECT name FROM kl_migrations
 WHERE name IN ('003_wechat_identity.sql', '004_teacher_accounts.sql');
SELECT role, version FROM registration_codes ORDER BY role;
```

匿名检查公网域名，不携带任何凭证。

| 请求 | 放行条件 |
| --- | --- |
| `GET https://api.kelinliuxue.com/api/health` | HTTP 200，响应中 `success=true`、`data.database=connected` |
| `GET /api/teacher-admin/users`、`GET /api/teacher-admin/codes` | 均返回 401。404 表示该路由尚不可用，应检查部署版本和反向代理；200 表示匿名访问控制异常 |
| `GET /api/auth/wechat/config` | 发布微信快捷登录时须返回 200 且 `data.mini=true`，随后用真机完成一次授权 |

教师管理入口为小程序「我的 → 教师管理」，API 使用小程序会话的 Bearer 令牌。沿用旧部署目录时，移除原网页静态目录 `backend/public/account/` 及反向代理中直接提供该目录的映射。发布后核对 `/account/`、`/account/admin.html`、`/api/auth/wechat/web/start` 和 `/api/auth/wechat/web/callback` 均返回 404。

## 3. 上传体验版，真机验收

在 Windows 发布机用有上传权限的微信账号登录开发者工具。选择第 1 节的干净项目根目录，确认 `project.config.json` 中的 AppID 与正式小程序一致。核对 `miniprogram/config/api.js` 的正式地址为 `https://api.kelinliuxue.com`，并在微信公众平台核对该域名的网络配置。

在发布目录打开 PowerShell。如果 CLI 装在其他位置，将第一行替换为实际的 `cli.bat` 路径。填写本次小程序版本号后执行。成功上传后，管理员可在微信公众平台的版本管理中选择对应开发版本，设为体验版并分配体验权限。

```powershell
$cli = 'D:\Projects\miniapp-for-Kelin\backend\.local\wechat-devtools\cli.bat'
$project = (Get-Location).Path
$sha = git rev-parse --short HEAD
$version = Read-Host '输入本次小程序版本号'
& $cli upload --project $project --version $version --desc "教师管理与登录修复 $sha"
if ($LASTEXITCODE) { throw '上传失败，请检查项目路径、登录状态和上传权限' }
```

| 真机验收 | 预期表现 |
| --- | --- |
| 普通教师登录 → 我的 → 教师管理 | 展示账号和注册码；可按用户名、显示名、角色、状态筛选，无匹配时出现空状态 |
| 展开测试学生，修改显示名后重新进入 | 新名称保留；窄屏下输入文字水平和垂直居中，聚焦后仍可编辑，按钮可点 |
| 学生登录 | 「我的」没有教师管理入口；学生身份请求管理接口返回 403 |
| 用专用测试学生验证重置密码 | 先让学生登录并记住设备，再由教师重置；学生旧会话、旧设备凭证和旧密码失效，新密码能登录 |
| 微信快捷登录 | 真实微信授权进入预期账号，首次使用的测试身份按提示绑定或注册 |

注册码轮换和批量状态变更在隔离环境验证。生产冒烟仅使用专用测试账号；生产注册码轮换按实际发码计划执行。

## 4. 提审、发布与回滚

管理员在微信公众平台核对体验版版本号和 SHA，提交审核。需要审核员登录时使用专用审核账号。审核通过后选择已验收的版本发布，再从正式小程序重复教师入口、学生权限、登录及公网健康检查。记录发布人、时间、后端 SHA、小程序版本号、验收结果和上一可用版本。

- **后端启动或迁移失败**：停止切换和小程序发布。检查 `pm2 logs file-manager-api --lines 50 --nostream`、失败的迁移语句和迁移记录。MySQL DDL 可能已部分生效，先核对实际表结构。恢复上一版代码、对应依赖和构建产物，沿用其正确的配置，再重启 PM2 并复验。
- **小程序发布后异常**：通过微信公众平台可用的版本回退操作恢复上一可用版本，核实教师和学生均可登录。后端应继续兼容仍在使用新旧客户端的用户，再决定是否回退后端。
- **涉及账号数据恢复**：保留现有注册码密钥和上传文件。旧后端可能恢复使用旧环境变量注册码，数据库恢复也可能覆盖发布后的改名、密码重置或重新引入已撤销的会话。由管理员先核对影响和新增数据，再决定是否恢复数据库；恢复后复核凭证撤销情况。
