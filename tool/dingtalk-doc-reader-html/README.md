# 钉钉文档登录认证与结构化读取工具

使用 Node.js + Playwright 复用钉钉登录态，读取钉钉文档正文、评论和图片资源，并导出为 HTML / JSON / 图片文件。

## 安装

```bash
cd dingtalk-doc-reader
npm install
npx playwright install chromium
```

## 使用

```bash
# 直接登录
npm run login

# 自动检测登录态后读取文档
npm run start -- <钉钉文档URL>

# 直接读取文档
npm run read -- <钉钉文档URL>

# 启动 MCP server（stdio）
npm run mcp

# 可见模式运行读取，便于调试
npm run read -- <钉钉文档URL> --visible
```

首次运行会自动弹出浏览器让你扫码登录，登录成功后会保存登录态到 `auth/` 目录。

## 输出

登录成功后，认证信息保存在 `auth/` 目录：

```text
auth/
├── state.json      # Playwright 原生 storage state
├── cookies.json    # Cookie 信息
└── storage.json    # LocalStorage 信息
```

读取结果保存在 `output/<时间戳>/` 目录：

```text
output/
└── 2026-03-19T09-00-00/
    ├── assets/         # 从正文/评论中提取出的图片资产
    ├── document.html   # 合并后的高保真 HTML
    ├── comments.json   # 评论结构化结果
    └── document.json   # 完整结构化输出
```

## 说明

- 登录态保存在 `auth/` 目录，有效期通常为几天到几周
- 程序优先使用 `state.json`，也兼容旧版 `cookies.json` + `storage.json`
- 正文优先读取钉钉文档真实接口，再尽量保留标题、列表、表格、链接、行内样式和图片的 HTML 结构
- 正文与评论中的图片会单独下载到 `assets/` 目录，并在 HTML 中以相对路径引用
- 最终只输出一个 `document.html`，其中包含正文和评论两个部分
- 评论会优先尝试多个文档标识对应的接口，避免只依赖单一路径
- 如果需要重新登录，删除 `auth/` 目录下的文件后重新运行即可

## MCP

项目现在可以直接作为一个 `stdio MCP server` 启动：

```bash
npm run mcp
```

它提供两把工具：

- `read_dingtalk_doc`
  - 输入钉钉文档 URL
  - 返回正文文字、正文 HTML、评论文字、评论 HTML、正文图片清单、评论图片清单
  - 默认只返回图片元信息和本地文件路径；如果需要，也可以通过 `include_image_data=true` 内联少量图片 data URI

- `read_dingtalk_doc_asset`
  - 输入 `read_dingtalk_doc` 返回的 `filePath`
  - 返回该图片的 `dataUri/base64`、MIME 类型和文件大小

推荐的调用方式是：

1. 先用 `read_dingtalk_doc` 读取正文和评论，同时拿到图片清单
2. 再按需对某几张图片调用 `read_dingtalk_doc_asset`

这样既能完整读取“文字 + 图片”，也不会因为一次内联太多图片把 MCP 响应撑得过大。
