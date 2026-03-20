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

- **`AUTH_OK`** → 继续下一步
- **`AUTH_MISSING`** → 需要扫码登录，执行：
  ```bash
  npm run login
  ```
- **`AUTH_CHECK_FAILED`** → 可能 node 环境异常或依赖未安装，先执行：
  ```bash
  npm install && npm run login
  ```

**登录失败的处理**：
- 如果登录超时（5 分钟内未完成扫码），告知用户重新执行 `npm run login`
- 如果报 `browserType.launch` 错误，说明 Playwright 浏览器未安装，执行：
  ```bash
  npx playwright install chromium
  ```
  安装完成后重新执行登录

**调试选项**：
- 登录过程默认就是可见模式（会弹出浏览器窗口供扫码）
- 文档读取默认是无头模式，如需调试可加 `--visible` 参数（见第二步）

### 第二步：执行文档读取

从 `$ARGUMENTS` 中提取钉钉文档 URL，运行：

```bash
node ./src/read.js "<文档URL>"
```

**可选参数**：
- `--visible` 或 `-v`：以可见模式运行浏览器，用于调试页面加载或登录态问题

从命令输出中提取 `输出目录` 路径（形如 `/tmp/dingtalk-doc-reader/2026-xx-xxTxx-xx-xx`）。

**常见错误处理**：

| 错误信息 | 原因 | 处理方式 |
|---------|------|---------|
| `未捕获到正文接口响应` | 登录态过期或页面加载异常 | 重新执行 `npm run login` 登录后重试 |
| `browserType.launch` | Playwright 浏览器未安装 | 执行 `npx playwright install chromium` |
| `net::ERR_` / `Timeout` | 网络超时 | 等待几秒后重试一次 |
| `Navigation failed` | 文档 URL 无效或无权限 | 提示用户确认 URL 正确且有访问权限 |

### 第三步：读取输出文件

按以下策略读取文件：

#### 必读文件
1. **document.html** — 完整的结构化 HTML 页面，包含正文和评论的全部内容，是主要内容来源

#### 按需读取
2. **comments.json** — 仅在用户明确关心评论详情（如评论者、时间等结构化信息）时读取
3. **document.json** — 文件较大，仅在需要结构化数据（如提取特定字段、分析文档结构）时读取

#### 图片读取策略
4. **assets/ 目录下的图片** — 不要默认全部读取，按以下策略处理：
   - 先用 Glob 工具查看 `assets/` 目录下有哪些图片文件，了解图片数量
   - 如果图片数量 ≤ 3 张，可以全部读取
   - 如果图片数量 > 3 张，告知用户有 N 张图片，询问是否需要查看，或仅在用户明确要求时读取指定图片
   - 文件命名规则：`content-*.png` 为正文图片，`comment-*.png` 为评论图片

### 第四步：向用户汇报

默认使用**概览模式**汇报，用户追问时切换到**详细模式**。

#### 概览模式（默认）

```
📄 **{文档标题}**

**摘要**：{用 2-3 句话概括文档核心内容}

**主要内容**：
- {要点 1}
- {要点 2}
- {要点 3}
...

**评论**：共 {N} 条评论{，如有重要评论可列出 1-2 条关键评论}
**图片**：共 {N} 张图片
**输出目录**：`{路径}`
```

#### 详细模式（用户追问时）

展示完整正文内容、所有评论详情、按需展示图片描述。
