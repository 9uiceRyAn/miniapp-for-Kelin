# 学习工作台样式入口

已确认布局：桌面与手机保留聊天 / 题库 / 个人底栏；题库侧栏选学科，主区按 tag 过滤并分组。原业务接口、资源修订和权限继续使用 Kelin 实现。

## 调整外观

- `miniprogram/styles/workspace-tokens.wxss`：主题色、字体、字号、圆角、侧栏宽度、底栏高度、内容宽度、页面间距。优先在这里修改。
- `miniprogram/styles/workspace-layout.wxss`：侧栏、抽屉、头部、固定底栏与 700px 响应式断点。
- `miniprogram/styles/workspace-content.wxss`：知识点标签、题目行、搜索栏、聊天输入和个人中心。
- `miniprogram/pages/learning/index.wxss`、`chat/chat.wxss`、`question/detail.wxss`：页面样式入口，引用上述公共文件。
- `backend/.local/video-demo/preview.css`：仅本地浏览器预览外框和原生标签归一化；不是正式产品主题。

所有新产品样式限定在 `.workspace-shell` 内，旧资料首页、登录、教师编辑器和管理页面不随本次主题变更。JS 负责数据与交互，不注入 CSS；WXML 只使用语义 class。

## 分类语义

侧栏学科来自 `/api/question-bank/facets`。主区标签来自所选学科各数据集的 `/api/question-bank/taxonomy`，标签以 collection + code 区分。选择具体标签时同时约束 collection，避免不同数据集相同 code 串题。主区显示真实题目，不使用设计预览中的示例题。

## 本地验收

在 backend 下运行 `node --test test/workspace-ui.test.js test/native.test.js`、`npm test`、`npm run check:mini`。
浏览器预览 `/` 支持桌面 / 手机和教师 / 学生切换， `/phone` 为实际页面。模型仍使用原本受控演示服务，浏览器适配不能替代微信真机验收。

## 教学资料管家

教师从聊天侧栏或个人页进入专用管理会话，记录按 Agent 角色出现在最近会话中。学生保留公共资料浏览。Agent 可检索公共资料和 A–E 文件，提出文字新增、已有文件索引、会话附件发布、资料替换和撤下操作；卡片经教师确认后执行。文件解析期间显示进行中，最终修订冲突会报告失败，不覆盖新修订。颜色和布局仍使用 workspace-content.wxss 与主题变量。
