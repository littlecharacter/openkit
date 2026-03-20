---
name: dingtalk-doc-reader
description: 读取钉钉文档的正文、评论和图片内容。当用户提供钉钉文档URL(alidocs.dingtalk.com)时使用此skill。
disable-model-invocation: false
---

## 当前登录状态

!`node -e "const {hasUsableAuthState} = await import('./src/auth.js'); console.log(hasUsableAuthState() ? 'AUTH_OK' : 'AUTH_MISSING');" 2>/dev/null || echo "AUTH_CHECK_FAILED"`

## 使用说明

读取钉钉文档内容，支持正文、评论和图片。

**用法**: `/dingtalk-doc-reader <钉钉文档URL>`

## 执行流程

### 第一步：检查登录态

检查上方的登录状态输出：
- 如果是 `AUTH_OK`，继续下一步
- 如果是 `AUTH_MISSING` 或 `AUTH_CHECK_FAILED`，告知用户需要先执行以下命令完成扫码登录：
  ```
  npm run login
  ```
  然后停止执行。

### 第二步：执行文档读取

从 `$ARGUMENTS` 中提取钉钉文档 URL，运行以下命令读取文档：

```bash
node ./src/read.js "<文档URL>"
```

从命令输出中提取 `输出目录` 路径（形如 `/tmp/dingtalk-doc-reader/2026-xx-xxTxx-xx-xx`）。

### 第三步：读取输出文件

按以下优先级读取文件：

1. **document.html** - 完整的结构化 HTML 页面（优先读取，包含正文全部内容）
2. **comments.json** - 评论数据（包含评论者、时间、内容）
3. **assets/ 目录下的图片** - 使用 Read 工具读取所有图片文件（content-*.png 为正文图片，comment-*.png 为评论图片）

**注意**：
- 所有图片都要逐一读取，不要跳过
- 如果图片较多，分批读取（每批不超过 3 张）
- document.json 通常较大且与 document.html 内容重复，除非用户明确要求否则不读取

### 第四步：向用户汇报

将文档内容整理后呈现给用户，包括：
- 文档标题和正文摘要
- 评论内容（评论者 + 评论内容 + 时间）
- 图片描述（读取图片后描述其内容）
- 输出目录路径，方便用户后续查看
