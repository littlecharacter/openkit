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

读取结果保存在 `/tmp/dingtalk-doc-reader/<时间戳>/` 目录：

```text
/tmp/dingtalk-doc-reader/
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
