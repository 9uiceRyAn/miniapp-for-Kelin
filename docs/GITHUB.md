# GitHub publication — v0.1

本项目计划的名称是 **miniapp for Kelin**。

GitHub repository name 本身不能包含空格，因此实际仓库名使用：

```text
miniapp-for-Kelin
```

Description：

```text
为了个人学习创建
```

建议第一次发布为 private repository；后续如果确认可以公开，再修改 visibility。

## 1. Install GitHub CLI (Mac)

确认是否已有：

```bash
gh --version
```

如果没有：

```bash
brew install gh
```

登录 GitHub：

```bash
gh auth login
```

推荐选择：

```text
GitHub.com
HTTPS
Login with a web browser
```

确认：

```bash
gh auth status
```

## 2. Enter the final project folder

示例：

```bash
cd ~/Downloads/miniapp-for-Kelin-v0.1
```

先检查：

```bash
pwd
ls
```

应看到：

```text
README.md
agent.md
backend
miniprogram
database
docs
project.config.json
```

## 3. Safety check

确认不应提交的文件：

```bash
git check-ignore -v \
  backend/.env \
  project.private.config.json \
  2>/dev/null || true
```

检查仓库内没有明显 secret：

```bash
grep -RInE \
  'DB_PASSWORD=.*[^E]$|TEACHER_REGISTER_CODE=.*[^E]$|STUDENT_REGISTER_CODE=.*[^E]$' \
  . \
  --exclude='.env.example' \
  --exclude-dir='.git' \
  --exclude-dir='node_modules' \
  || true
```

人工确认不要把真实密码 / 注册码 / token 提交。

## 4. Initialize Git

```bash
git init
git branch -M main
```

如本机尚未配置 Git identity：

```bash
git config --global user.name "YOUR NAME"
git config --global user.email "YOUR_GITHUB_EMAIL"
```

## 5. Add and review files

```bash
git add .
git status
```

`git status` 中不应该出现：

```text
backend/.env
project.private.config.json
node_modules/
uploads/
__MACOSX/
.DS_Store
```

## 6. First commit — v0.1

推荐 commit message：

```bash
git commit -m "release: v0.1 stable handoff"
```

## 7. Create v0.1 tag locally

```bash
git tag -a v0.1 \
  -m "v0.1: stable miniapp handoff"
```

确认：

```bash
git log -1 --oneline
git tag --list
```

## 8. Create the GitHub repository and push main

```bash
gh repo create miniapp-for-Kelin \
  --private \
  --description "为了个人学习创建" \
  --source=. \
  --remote=origin \
  --push
```

然后把 tag 推上去：

```bash
git push origin v0.1
```

确认 remote：

```bash
git remote -v
```

打开仓库：

```bash
gh repo view --web
```

## 9. Create GitHub Release v0.1

```bash
gh release create v0.1 \
  --title "v0.1" \
  --notes "Initial stable handoff. Includes self-hosted Express/MySQL backend, teacher/student authentication and permissions, A-E file management, upload/download/ZIP export, per-user file marks and hide-marked filtering, responsive COLLINS UI, deployment documentation, and AI-agent handoff context."
```

## 10. Give the next developer access

先确认对方 GitHub username，例如：

```text
NEXT_DEVELOPER_GITHUB_USERNAME
```

设置变量：

```bash
OWNER=$(gh api user --jq .login)
COLLABORATOR="NEXT_DEVELOPER_GITHUB_USERNAME"
```

邀请为 **write** 权限：

```bash
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "/repos/${OWNER}/miniapp-for-Kelin/collaborators/${COLLABORATOR}" \
  -f permission='push'
```

对方需要在 GitHub 接受邀请。

如果只需要 read，可将：

```text
push
```

改成：

```text
pull
```

不要轻易给 `admin`，除非对方需要管理 repository 设置、权限或删除仓库。

## 11. Verify repository state

```bash
git status
git log --oneline --decorate -5
git tag -n
gh repo view
```

预期：

```text
branch: main
working tree: clean
tag: v0.1
release: v0.1
```

检查 release：

```bash
gh release view v0.1
```

## 12. Future workflow

后续开发不要继续往 v0.1 tag 上修改。建议：

```bash
git checkout main
git pull

git checkout -b feature/search-engine
# work...
git add .
git commit -m "feat: add server-side search"
git push -u origin feature/search-engine
```

然后通过 Pull Request 合并：

```bash
gh pr create
```

未来稳定版本继续 tag：

```text
v0.2
v0.3
v1.0
```
