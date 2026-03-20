import fs from 'fs';
import path from 'path';
import util from 'util';
import { fileURLToPath } from 'url';
import { readDocument } from './read.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(PROJECT_ROOT, 'output');
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
  name: 'dingtalk-doc-reader',
  version: '1.0.0',
};

const TOOL_DEFINITIONS = [
  {
    name: 'read_dingtalk_doc',
    description: '读取钉钉文档正文、评论与图片清单，返回文字内容、HTML 和图片元信息。',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '钉钉文档链接，例如 https://alidocs.dingtalk.com/i/nodes/xxxx',
        },
        visible: {
          type: 'boolean',
          description: '是否用可见浏览器运行，默认 false。调试时可设为 true。',
          default: false,
        },
        include_image_data: {
          type: 'boolean',
          description: '是否在结果里内联图片 data URI。默认 false。',
          default: false,
        },
        max_inline_images: {
          type: 'integer',
          description: '当 include_image_data=true 时，最多内联多少张图片，默认 0。',
          minimum: 0,
          default: 0,
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_dingtalk_doc_asset',
    description: '按文件路径读取 read_dingtalk_doc 生成的图片资源，返回 data URI 和元信息。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'read_dingtalk_doc 返回的 filePath，必须位于 output/ 目录下。',
        },
        as_data_uri: {
          type: 'boolean',
          description: '是否返回 data URI；默认 true。false 时只返回 base64。',
          default: true,
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
];

function formatLogArg(value) {
  if (typeof value === 'string') {
    return value;
  }

  return util.inspect(value, {
    depth: 6,
    colors: false,
    breakLength: 120,
  });
}

function logToStderr(...args) {
  process.stderr.write(`${args.map(formatLogArg).join(' ')}\n`);
}

async function withStderrConsole(task) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (...args) => logToStderr(...args);
  console.warn = (...args) => logToStderr(...args);
  console.error = (...args) => logToStderr(...args);

  try {
    return await task();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

function mimeTypeFromFilePath(filePath = '') {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  };
  return map[ext] || 'application/octet-stream';
}

function clampInlineImageLimit(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) {
    return 0;
  }

  return Math.max(0, Math.min(20, Math.floor(count)));
}

function ensureOutputFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('file_path 不能为空');
  }

  const resolved = path.resolve(filePath);
  const outputRoot = path.resolve(OUTPUT_ROOT);
  const isAllowed = resolved === outputRoot || resolved.startsWith(`${outputRoot}${path.sep}`);

  if (!isAllowed) {
    throw new Error('只允许读取当前项目 output/ 目录下的资源');
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`资源文件不存在: ${resolved}`);
  }

  return resolved;
}

function buildDataUri(filePath, mimeType) {
  const buffer = fs.readFileSync(filePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function normalizeAsset(asset, outputDir, role, options) {
  const relativePath = asset.relativePath || asset.markdownPath || '';
  const filePath = ensureOutputFilePath(asset.filePath || path.join(outputDir, relativePath));
  const mimeType = asset.mimeType || mimeTypeFromFilePath(filePath);
  const normalized = {
    id: asset.id,
    role,
    alt: asset.alt || '',
    fileName: asset.fileName || path.basename(filePath),
    filePath,
    relativePath,
    mimeType,
    sizeBytes: fs.statSync(filePath).size,
    sourceUrl: asset.sourceUrl || '',
    width: asset.width ?? null,
    height: asset.height ?? null,
  };

  if (options.includeImageData && options.inlineCounter.count < options.maxInlineImages) {
    normalized.dataUri = buildDataUri(filePath, mimeType);
    options.inlineCounter.count += 1;
  }

  return normalized;
}

function buildToolPayload(result, args) {
  const options = {
    includeImageData: Boolean(args.include_image_data),
    maxInlineImages: clampInlineImageLimit(args.max_inline_images),
    inlineCounter: { count: 0 },
  };

  const contentImages = (result.content.assets || []).map((asset) =>
    normalizeAsset(asset, result.outputDir, 'content', options)
  );

  const commentItems = (result.comments.items || []).map((comment) => {
    const images = (comment.assets || []).map((asset) =>
      normalizeAsset(asset, result.outputDir, 'comment', options)
    );

    return {
      id: comment.id,
      author: comment.author,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      summary: comment.summary,
      text: comment.rawText,
      html: comment.html,
      images,
    };
  });

  return {
    url: result.url,
    title: result.title,
    extractedAt: result.extractedAt,
    outputDir: result.outputDir,
    documentHtmlPath: path.join(result.outputDir, 'document.html'),
    documentJsonPath: path.join(result.outputDir, 'document.json'),
    metadata: result.metadata,
    content: {
      text: result.content.rawText,
      html: result.content.html,
      images: contentImages,
    },
    comments: {
      text: result.comments.rawText,
      html: result.comments.html,
      items: commentItems,
      images: commentItems.flatMap((item) => item.images),
    },
  };
}

function summarizePayload(payload, includeImageData) {
  const lines = [
    `标题: ${payload.title}`,
    `正文图片: ${payload.content.images.length}`,
    `评论数: ${payload.comments.items.length}`,
    `评论图片: ${payload.comments.images.length}`,
    `输出目录: ${payload.outputDir}`,
  ];

  if (!includeImageData) {
    lines.push('图片未内联，可继续调用 read_dingtalk_doc_asset 读取具体图片。');
  }

  return lines.join('\n');
}

async function handleReadDocument(args) {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) {
    throw new Error('url 不能为空');
  }

  const result = await withStderrConsole(() =>
    readDocument(url, {
      headless: !Boolean(args.visible),
    })
  );

  const payload = buildToolPayload(result, args);
  return {
    content: [
      {
        type: 'text',
        text: summarizePayload(payload, Boolean(args.include_image_data)),
      },
    ],
    structuredContent: payload,
  };
}

async function handleReadAsset(args) {
  const filePath = ensureOutputFilePath(args.file_path);
  const mimeType = mimeTypeFromFilePath(filePath);
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString('base64');
  const asDataUri = args.as_data_uri !== false;
  const result = {
    filePath,
    fileName: path.basename(filePath),
    mimeType,
    sizeBytes: buffer.length,
    base64,
  };

  if (asDataUri) {
    result.dataUri = `data:${mimeType};base64,${base64}`;
  }

  return {
    content: [
      {
        type: 'text',
        text: `已读取资源: ${result.fileName}\nMIME: ${result.mimeType}\n大小: ${result.sizeBytes} bytes`,
      },
    ],
    structuredContent: result,
  };
}

class McpStdioServer {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.initialized = false;
    this.outputEncoding = null;
  }

  start() {
    process.stdin.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer().catch((error) => {
        logToStderr('MCP processing error:', error);
      });
    });

    process.stdin.on('end', () => process.exit(0));
  }

  async processBuffer() {
    while (true) {
      this.trimLeadingNewlines();
      if (this.buffer.length === 0) {
        return;
      }

      if (this.looksLikeContentLengthMessage()) {
        const handled = await this.processContentLengthMessage();
        if (!handled) {
          return;
        }
        continue;
      }

      const handled = await this.processLineDelimitedMessage();
      if (!handled) {
        return;
      }
    }
  }

  trimLeadingNewlines() {
    while (this.buffer.length > 0 && (this.buffer[0] === 0x0a || this.buffer[0] === 0x0d)) {
      this.buffer = this.buffer.slice(1);
    }
  }

  looksLikeContentLengthMessage() {
    const preview = this.buffer.slice(0, Math.min(this.buffer.length, 64)).toString('utf8');
    return /^Content-Length:/i.test(preview);
  }

  async processContentLengthMessage() {
    if (!this.outputEncoding) {
      this.outputEncoding = 'content-length';
    }

    const headerEnd = this.buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return false;
    }

    const headerText = this.buffer.slice(0, headerEnd).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(headerText);
    if (!match) {
      throw new Error('MCP 消息缺少 Content-Length');
    }

    const contentLength = Number(match[1]);
    const messageEnd = headerEnd + 4 + contentLength;
    if (this.buffer.length < messageEnd) {
      return false;
    }

    const body = this.buffer.slice(headerEnd + 4, messageEnd).toString('utf8');
    this.buffer = this.buffer.slice(messageEnd);
    await this.parseAndHandleMessage(body);
    return true;
  }

  async processLineDelimitedMessage() {
    if (!this.outputEncoding) {
      this.outputEncoding = 'line';
    }

    const newlineIndex = this.buffer.indexOf('\n');
    if (newlineIndex === -1) {
      return false;
    }

    const line = this.buffer.slice(0, newlineIndex).toString('utf8').trim();
    this.buffer = this.buffer.slice(newlineIndex + 1);

    if (!line) {
      return true;
    }

    await this.parseAndHandleMessage(line);
    return true;
  }

  async parseAndHandleMessage(body) {
    let message = null;
    try {
      message = JSON.parse(body);
    } catch (error) {
      logToStderr('忽略无法解析的 MCP 消息:', error);
      return;
    }

    await this.handleMessage(message);
  }

  send(payload) {
    const json = JSON.stringify(payload);

    if (this.outputEncoding === 'content-length') {
      const bytes = Buffer.byteLength(json, 'utf8');
      process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
      return;
    }

    process.stdout.write(`${json}\n`);
  }

  sendResponse(id, result) {
    this.send({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  sendError(id, code, message, data) {
    this.send({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(data ? { data } : {}),
      },
    });
  }

  async handleMessage(message) {
    const { id, method, params } = message;

    if (!method) {
      if (id !== undefined) {
        this.sendError(id, -32600, '无效请求');
      }
      return;
    }

    try {
      if (method === 'initialize') {
        this.initialized = true;
        this.sendResponse(id, {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: SERVER_INFO,
        });
        return;
      }

      if (method === 'notifications/initialized') {
        return;
      }

      if (method === 'ping') {
        this.sendResponse(id, {});
        return;
      }

      if (method === 'tools/list') {
        this.sendResponse(id, {
          tools: TOOL_DEFINITIONS,
        });
        return;
      }

      if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};
        let result = null;

        if (toolName === 'read_dingtalk_doc') {
          result = await handleReadDocument(args);
        } else if (toolName === 'read_dingtalk_doc_asset') {
          result = await handleReadAsset(args);
        } else {
          result = {
            isError: true,
            content: [{ type: 'text', text: `未知工具: ${toolName}` }],
          };
        }

        this.sendResponse(id, result);
        return;
      }

      this.sendError(id, -32601, `不支持的方法: ${method}`);
    } catch (error) {
      if (id === undefined) {
        logToStderr('MCP notification failed:', error);
        return;
      }

      this.sendResponse(id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
  }
}

const server = new McpStdioServer();
server.start();
