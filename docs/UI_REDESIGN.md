# UI redesign — v0.1 final

本文件记录 v0.1 最终交接时的 UI / 品牌决策，便于后续开发保持一致。

## Goal

把原本偏“内部文件管理后台”的视觉调整为更像教育资料产品，同时避免照搬其他题库网站。

本轮只调整视觉与信息层级，没有改变文件管理、权限、marks、上传下载等核心业务契约。

## Brand system

- Primary: `#9B1F58`
- Background: 低饱和暖灰 / 暖白
- Main text: 深灰黑
- Secondary text: 低饱和灰
- Card border / shadow: very light
- Logo: `miniprogram/images/collins-logo.png`

没有引入外部 font file 或第三方 UI framework。

## Typography

- 大标题：优先系统宋体 / serif fallback，形成编辑型教育内容感。
- 正文、按钮、表单：系统 sans-serif，保证移动端阅读与兼容性。
- 通过字号、字重、留白建立层级，而不是大量使用高饱和颜色。

## Login page

最终 Hero：

```text
归档 · 检索 · 标记
```

左上品牌使用 Collins Cambridge International Centre logo，不再使用临时 `C` 图形。

原先 01 / 02 / 03 三个重复功能说明卡已删除，信息集中到大标题与说明文字中。

## Home page

最终 Hero：

```text
熟能生巧。
```

不使用与参考页面相似的长句。

已删除四个 summary cards：

```text
全部资料
当前分类
我的标记
当前显示
```

保留：

- 品牌顶栏
- Hero / 简介
- 刷新资料
- 导出当前分类
- 教师导入文件
- A–E 横向分类浏览
- 当前分类标题
- 搜索
- 隐藏已标记
- 文件列表 / 手机文件卡片

## File information hierarchy

用户可见主要信息：

1. 文件名
2. 个人标记
3. 文件类型 / 大小
4. 上传者
5. 导入时间
6. 操作

数据库内部 `files.id` 不在 UI 中显示，但仍是核心内部主键。

## Upload time

服务端可返回 UTC ISO 时间，例如：

```text
2026-09-07T06:19:01.000Z
```

UI 统一转换为北京时间 UTC+8，并使用 AM / PM：

```text
2026/09/07 2:19 PM
```

## Upload-source UX

Desktop：

```text
导入文件 -> 直接文件选择
```

不再二次选择 PDF / PPT / Word / Excel。

Mobile：

```text
相册图片或视频
拍照或录像
微信聊天文件
```

v0.1 暂不做系统文件浏览器。

## Future UI extensions

后续 metadata/tag、advanced search、AI Chatbot 应尽量复用：

- 当前品牌色
- 卡片圆角与低对比边界
- Serif hero + sans-serif content
- 横向分类 / filter 语言
- 当前文件列表的信息层级

新增功能时不要重新做一套完全独立的视觉系统。
