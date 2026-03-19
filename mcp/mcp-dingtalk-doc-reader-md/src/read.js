import fs from 'fs';
import path from 'path';
import {
  createBrowserSession,
  ensureCommentPanel,
  ensureOutputDir,
  generateOutputDir,
  openDingTalkDocument,
} from './dingtalk.js';

const DINGTALK_ORIGIN = 'https://alidocs.dingtalk.com';
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2060-\u206F\uFEFF]/g;
const INLINE_TAGS = new Set([
  'span',
  'a',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'code',
  'leaf',
  'text',
]);

const MIME_EXTENSION_MAP = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

function cleanInlineText(text) {
  return String(text || '')
    .replace(ZERO_WIDTH_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(title) {
  return (
    cleanInlineText(title)
      .replace(/^[^\p{L}\p{N}\p{Script=Han}]+/u, '')
      .replace(/\.(adoc|docx?|xlsx?|pptx?)$/i, '')
      .replace(/\s*[·|-]\s*DingTalk Docs$/i, '') || '钉钉文档'
  );
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function buildCookieHeader(cookies) {
  const nowSeconds = Date.now() / 1000;
  return cookies
    .filter((cookie) => typeof cookie.expires !== 'number' || cookie.expires === -1 || cookie.expires > nowSeconds)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function guessExtension(sourceUrl = '', mimeType = '') {
  if (mimeType && MIME_EXTENSION_MAP[mimeType]) {
    return MIME_EXTENSION_MAP[mimeType];
  }

  try {
    const pathname = new URL(sourceUrl).pathname;
    const ext = path.extname(pathname).replace('.', '').toLowerCase();
    if (ext) {
      return ext;
    }
  } catch {
    // ignore
  }

  if (sourceUrl.startsWith('data:image/png')) return 'png';
  if (sourceUrl.startsWith('data:image/jpeg')) return 'jpg';
  if (sourceUrl.startsWith('data:image/webp')) return 'webp';
  if (sourceUrl.startsWith('data:image/gif')) return 'gif';
  return 'png';
}

function resolveSourceUrl(sourceUrl = '') {
  if (!sourceUrl) {
    return '';
  }

  if (sourceUrl.startsWith('data:')) {
    return sourceUrl;
  }

  try {
    return new URL(sourceUrl, DINGTALK_ORIGIN).toString();
  } catch {
    return sourceUrl;
  }
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) {
    throw new Error('无效的 data URL');
  }

  return {
    mimeType: match[1].toLowerCase(),
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function createResponseCollector(page) {
  const state = {
    documentResponses: [],
    commentResponses: [],
  };

  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/api/document/data') && !url.includes('/core/api/comment/list')) {
      return;
    }

    let json = null;
    try {
      json = await response.json();
    } catch {
      return;
    }

    const entry = {
      url,
      frameUrl: response.frame()?.url?.() || null,
      json,
    };

    if (url.includes('/api/document/data')) {
      state.documentResponses.push(entry);
    } else {
      state.commentResponses.push(entry);
    }
  });

  return state;
}

function pickMainDocumentResponse(documentResponses, frameUrl) {
  const exactMatches = documentResponses.filter((entry) => entry.frameUrl === frameUrl);
  const candidates = exactMatches.length > 0 ? exactMatches : documentResponses;

  return candidates
    .map((entry) => ({
      ...entry,
      cpOssSize: entry.json?.data?.documentContent?.checkpoint?.cpOssSize || 0,
    }))
    .sort((left, right) => right.cpOssSize - left.cpOssSize)[0] || null;
}

function pickCommentResponse(commentResponses, frameUrl) {
  const exactMatches = commentResponses.filter((entry) => entry.frameUrl === frameUrl);
  const candidates = exactMatches.length > 0 ? exactMatches : commentResponses;
  const nonEmptyCandidates = candidates.filter((entry) => (entry.json?.data?.data?.length || 0) > 0);
  const targetCandidates = nonEmptyCandidates.length > 0 ? nonEmptyCandidates : candidates;
  return targetCandidates[targetCandidates.length - 1] || null;
}

function selectCommentResponse(activeResponse, passiveResponse) {
  const activeCount = activeResponse?.json?.data?.data?.length || 0;
  if (activeCount > 0) {
    return activeResponse;
  }

  const passiveCount = passiveResponse?.json?.data?.data?.length || 0;
  if (passiveCount > 0) {
    return passiveResponse;
  }

  return activeResponse || passiveResponse || null;
}

async function fetchDentryInfo(page, documentUrl) {
  let dentryUuid = '';
  try {
    dentryUuid = new URL(documentUrl).pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    dentryUuid = '';
  }

  if (!dentryUuid) {
    return null;
  }

  return page.evaluate(async ({ dentryUuid }) => {
    try {
      const response = await fetch(`/box/api/v1/page/init/node?dentryUuid=${encodeURIComponent(dentryUuid)}`);
      const json = await response.json();
      return json?.data?.dentryInfo?.data || null;
    } catch {
      return null;
    }
  }, { dentryUuid });
}

async function readMetaTitle(page, frame) {
  const readers = [
    async () => page.locator('meta[property="og:title"]').first().getAttribute('content'),
    async () => frame.locator('meta[property="og:title"]').first().getAttribute('content'),
    async () => page.title(),
  ];

  for (const reader of readers) {
    const value = cleanInlineText(await reader().catch(() => ''));
    if (value) {
      return cleanTitle(value);
    }
  }

  return '钉钉文档';
}

function buildCommentObjectIds(dentryInfo, frame) {
  let frameUrl = null;
  try {
    frameUrl = new URL(frame.url());
  } catch {
    frameUrl = null;
  }

  return [
    dentryInfo?.docKey,
    dentryInfo?.dentryKey,
    dentryInfo?.dentryUuid,
    dentryInfo?.dentryId,
    dentryInfo?.driveDentryId ? String(dentryInfo.driveDentryId) : '',
    frameUrl?.searchParams.get('docId') || '',
    frameUrl?.searchParams.get('docKey') || '',
    frameUrl?.searchParams.get('dentryKey') || '',
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

async function fetchCommentsByObjectIds(frame, objectIds) {
  let lastResponse = null;

  for (const objectId of objectIds) {
    const response = await frame.evaluate(async ({ objectId }) => {
      try {
        const res = await fetch('/core/api/comment/list', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pageSize: 200, sortType: 0, objectId }),
        });
        const json = await res.json();
        return {
          objectId,
          status: res.status,
          json,
        };
      } catch (error) {
        return {
          objectId,
          error: String(error),
          json: null,
        };
      }
    }, { objectId });

    if (response?.json) {
      lastResponse = response;
    }

    if ((response?.json?.data?.data?.length || 0) > 0) {
      return response;
    }
  }

  return lastResponse;
}

async function loadComments(page, frame, collector, dentryInfo) {
  const objectIds = buildCommentObjectIds(dentryInfo, frame);
  let selectedResponse = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt === 0 || attempt === 2) {
      await ensureCommentPanel(page, frame).catch(() => null);
    }

    if (attempt > 0) {
      await page.waitForTimeout(1200);
    }

    const activeCommentResponse = await fetchCommentsByObjectIds(frame, objectIds);
    const passiveCommentResponse = pickCommentResponse(collector.commentResponses, frame.url());
    selectedResponse = selectCommentResponse(activeCommentResponse, passiveCommentResponse);

    if ((selectedResponse?.json?.data?.data?.length || 0) > 0) {
      return selectedResponse;
    }
  }

  return selectedResponse;
}

function createParseState(prefix) {
  return {
    assetPrefix: prefix,
    nextAssetIndex: 1,
    assets: [],
    assetSignatureToId: new Map(),
  };
}

function registerAsset(state, attrs = {}) {
  const sourceUrl = resolveSourceUrl(attrs.src || attrs.url || attrs.href || '');
  const width =
    attrs.width ||
    attrs.originWidth ||
    attrs?.extraData?.metaData?.originWidth ||
    attrs?.extraData?.metaData?.width ||
    null;
  const height =
    attrs.height ||
    attrs.originHeight ||
    attrs?.extraData?.metaData?.originHeight ||
    attrs?.extraData?.metaData?.height ||
    null;
  const alt = cleanInlineText(attrs.alt || attrs.name || attrs.title || '');
  const signature = JSON.stringify([sourceUrl, width, height, alt]);

  if (state.assetSignatureToId.has(signature)) {
    return state.assetSignatureToId.get(signature);
  }

  const assetId = `${state.assetPrefix}-asset-${state.nextAssetIndex++}`;
  state.assets.push({
    id: assetId,
    sourceUrl,
    alt,
    width,
    height,
    name: attrs.name || '',
  });
  state.assetSignatureToId.set(signature, assetId);
  return assetId;
}

function wrapSegments(type, value, segments) {
  return [{
    type,
    ...(value ? value : {}),
    children: segments,
  }];
}

function isSimpleColor(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }

  const color = value.trim();
  if (!color || color.includes('__')) {
    return false;
  }

  return /^#([0-9a-f]{3,8})$/i.test(color) || /^(rgb|hsl)a?\(/i.test(color) || /^[a-z]+$/i.test(color);
}

function applyInlineAttrsToSegments(attrs, segments) {
  let styledSegments = segments;

  if (isSimpleColor(attrs.highlight)) {
    styledSegments = wrapSegments('mark', { color: attrs.highlight }, styledSegments);
  }

  if (isSimpleColor(attrs.color) && attrs.color !== '#222328') {
    styledSegments = wrapSegments('color', { color: attrs.color }, styledSegments);
  }

  if (attrs.bold) {
    styledSegments = wrapSegments('strong', null, styledSegments);
  }

  if (attrs.italic) {
    styledSegments = wrapSegments('em', null, styledSegments);
  }

  if (attrs.underline) {
    styledSegments = wrapSegments('underline', null, styledSegments);
  }

  if (attrs.strike) {
    styledSegments = wrapSegments('strike', null, styledSegments);
  }

  return styledSegments;
}

function hasMeaningfulSegments(segments) {
  return segments.some((segment) => {
    if (segment.type === 'text') {
      return cleanInlineText(segment.text).length > 0;
    }

    return true;
  });
}

function appendTextSegment(segments, text) {
  if (!text) {
    return;
  }

  const normalized = String(text).replace(ZERO_WIDTH_RE, '');
  if (!normalized) {
    return;
  }

  const last = segments[segments.length - 1];
  if (last && last.type === 'text') {
    last.text += normalized;
    return;
  }

  segments.push({ type: 'text', text: normalized });
}

function extractInlineChildren(children, state) {
  const segments = [];

  for (const child of children) {
    const childSegments = extractInlineSegments(child, state);
    for (const segment of childSegments) {
      if (segment.type === 'text') {
        appendTextSegment(segments, segment.text);
      } else {
        segments.push(segment);
      }
    }
  }

  return segments;
}

function extractInlineSegments(node, state) {
  if (node == null || node === false) {
    return [];
  }

  if (typeof node === 'string') {
    return node ? [{ type: 'text', text: node }] : [];
  }

  if (!Array.isArray(node)) {
    return [];
  }

  const [tag, attrs = {}, ...children] = node;

  if (tag === 'img') {
    const assetId = registerAsset(state, attrs);
    return [{ type: 'image', assetId }];
  }

  if (tag === 'br') {
    return [{ type: 'break' }];
  }

  if (attrs['data-type'] === 'mention' || tag === 'mention') {
    const name = cleanInlineText(attrs.name || attrs.login || '');
    return [{ type: 'mention', text: name ? `@${name}` : '@' }];
  }

  if (tag === 'a' || attrs.href || attrs.url) {
    return [{
      type: 'link',
      href: resolveSourceUrl(attrs.href || attrs.url || ''),
      children: extractInlineChildren(children, state),
    }];
  }

  if (tag === 'strong' || tag === 'b') {
    return applyInlineAttrsToSegments(attrs, [{
      type: 'strong',
      children: extractInlineChildren(children, state),
    }]);
  }

  if (tag === 'em' || tag === 'i') {
    return applyInlineAttrsToSegments(attrs, [{
      type: 'em',
      children: extractInlineChildren(children, state),
    }]);
  }

  if (tag === 'u') {
    return applyInlineAttrsToSegments(attrs, [{
      type: 'underline',
      children: extractInlineChildren(children, state),
    }]);
  }

  if (tag === 's') {
    return applyInlineAttrsToSegments(attrs, [{
      type: 'strike',
      children: extractInlineChildren(children, state),
    }]);
  }

  if (tag === 'code') {
    return [{
      type: 'code',
      text: extractInlineChildren(children, state)
        .map((segment) => {
          if (segment.type === 'text') {
            return segment.text;
          }
          if (segment.type === 'mention') {
            return segment.text;
          }
          return '';
        })
        .join('')
        .replace(ZERO_WIDTH_RE, ''),
    }];
  }

  if (INLINE_TAGS.has(tag) || attrs['data-type'] === 'text') {
    return applyInlineAttrsToSegments(attrs, extractInlineChildren(children, state));
  }

  return applyInlineAttrsToSegments(attrs, extractInlineChildren(children, state));
}

function segmentsToPlainText(segments) {
  return segments
    .map((segment) => {
      if (segment.type === 'text') {
        return segment.text;
      }

      if (segment.type === 'break') {
        return '\n';
      }

      if (segment.type === 'mention') {
        return segment.text;
      }

      if (segment.type === 'image') {
        return '[图片]';
      }

      if (segment.type === 'code') {
        return segment.text;
      }

      if (segment.children) {
        return segmentsToPlainText(segment.children);
      }

      return '';
    })
    .join('');
}

function plainTextFromNode(node, state) {
  return cleanInlineText(segmentsToPlainText(extractInlineSegments(node, state)));
}

function pushSegmentsAsBlock(segments, blocks, createBlock) {
  if (!hasMeaningfulSegments(segments)) {
    return;
  }

  blocks.push(createBlock(segments));
}

function parseTableRows(tableNode, state) {
  const rows = [];

  if (!Array.isArray(tableNode)) {
    return rows;
  }

  const [, , ...rowNodes] = tableNode;
  for (const rowNode of rowNodes) {
    if (!Array.isArray(rowNode) || rowNode[0] !== 'tr') {
      continue;
    }

    const cells = [];
    const [, , ...cellNodes] = rowNode;
    for (const cellNode of cellNodes) {
      if (!Array.isArray(cellNode) || cellNode[0] !== 'tc') {
        continue;
      }

      const [, , ...cellChildren] = cellNode;
      const cellBlocks = [];
      for (const child of cellChildren) {
        parseAstNode(child, state, cellBlocks);
      }

      const groupedBlocks = groupListBlocks(cellBlocks);
      const cellText = rawTextFromBlocks(groupedBlocks);
      cells.push({
        text: cellText,
        blocks: groupedBlocks,
      });
    }

    if (cells.some((cell) => cell.text || cell.blocks.length > 0)) {
      rows.push(cells);
    }
  }

  return rows;
}

function parseAstNode(node, state, blocks) {
  if (!Array.isArray(node)) {
    return;
  }

  const [tag, attrs = {}, ...children] = node;

  if (tag === 'root' || tag === 'container') {
    for (const child of children) {
      parseAstNode(child, state, blocks);
    }
    return;
  }

  if (/^h[1-6]$/.test(tag)) {
    const segments = children.flatMap((child) => extractInlineSegments(child, state));
    pushSegmentsAsBlock(segments, blocks, (inlineSegments) => ({
      type: 'heading',
      level: Number(tag.slice(1)),
      segments: inlineSegments,
    }));
    return;
  }

  if (tag === 'p') {
    const segments = children.flatMap((child) => extractInlineSegments(child, state));
    if (attrs.list) {
      pushSegmentsAsBlock(segments, blocks, (inlineSegments) => ({
        type: 'list_item',
        listId: attrs.list.listId || '',
        level: attrs.list.level || 0,
        ordered: Boolean(attrs.list.isOrdered),
        checked: Boolean(attrs.list.isChecked),
        checkable: Boolean(attrs.list?.isTaskList),
        listFormat: attrs.list?.listStyle?.format || (attrs.list?.isOrdered ? 'decimal' : 'bullet'),
        listSymbol: attrs.list?.listStyle?.text || '',
        segments: inlineSegments,
      }));
    } else {
      pushSegmentsAsBlock(segments, blocks, (inlineSegments) => ({
        type: 'paragraph',
        indentLeft: Number(attrs.ind?.left || 0),
        segments: inlineSegments,
      }));
    }
    return;
  }

  if (tag === 'blockquote') {
    const segments = children.flatMap((child) => extractInlineSegments(child, state));
    pushSegmentsAsBlock(segments, blocks, (inlineSegments) => ({
      type: 'quote',
      indentLeft: Number(attrs.ind?.left || 0),
      segments: inlineSegments,
    }));
    return;
  }

  if (tag === 'pre') {
    const text = cleanInlineText(children.map((child) => plainTextFromNode(child, state)).join('\n'));
    if (text) {
      blocks.push({ type: 'code', text });
    }
    return;
  }

  if (tag === 'table') {
    const rows = parseTableRows(node, state);
    if (rows.length > 0) {
      blocks.push({ type: 'table', rows });
    }
    return;
  }

  if (tag === 'img') {
    const assetId = registerAsset(state, attrs);
    blocks.push({ type: 'image', assetId });
    return;
  }

  if (INLINE_TAGS.has(tag)) {
    const segments = extractInlineSegments(node, state);
    pushSegmentsAsBlock(segments, blocks, (inlineSegments) => ({ type: 'paragraph', segments: inlineSegments }));
    return;
  }

  for (const child of children) {
    parseAstNode(child, state, blocks);
  }
}

function groupListBlocks(blocks) {
  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current) {
      return;
    }

    grouped.push({
      type: 'list',
      ordered: current.ordered,
      items: current.items,
    });
    current = null;
  };

  for (const block of blocks) {
    if (block.type !== 'list_item') {
      flush();
      grouped.push(block);
      continue;
    }

    if (!current || current.ordered !== block.ordered) {
      flush();
      current = {
        ordered: block.ordered,
        items: [{
          level: block.level,
          checked: block.checked,
          checkable: block.checkable,
          listFormat: block.listFormat,
          listSymbol: block.listSymbol,
          segments: block.segments,
        }],
      };
      continue;
    }

    current.items.push({
      level: block.level,
      checked: block.checked,
      checkable: block.checkable,
      listFormat: block.listFormat,
      listSymbol: block.listSymbol,
      segments: block.segments,
    });
  }

  flush();
  return grouped;
}

function escapeInlineText(text, { inTable = false } = {}) {
  const normalized = String(text || '').replace(ZERO_WIDTH_RE, '');
  if (inTable) {
    return normalized.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  }

  return normalized;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInlineMarkdown(segments, assetsById, options = {}) {
  return segments
    .map((segment) => {
      if (segment.type === 'text') {
        return escapeInlineText(segment.text, options);
      }

      if (segment.type === 'break') {
        return options.inTable ? '<br>' : '  \n';
      }

      if (segment.type === 'mention') {
        return escapeInlineText(segment.text, options);
      }

      if (segment.type === 'image') {
        const asset = assetsById.get(segment.assetId);
        return asset ? `![${asset.alt || asset.fileName}](${asset.markdownPath})` : '[图片]';
      }

      if (segment.type === 'link') {
        const label = renderInlineMarkdown(segment.children || [], assetsById, options).trim() || segment.href;
        return `[${label}](${segment.href})`;
      }

      if (segment.type === 'strong') {
        const content = renderInlineMarkdown(segment.children || [], assetsById, options).trim();
        return content ? `**${content}**` : '';
      }

      if (segment.type === 'em') {
        const content = renderInlineMarkdown(segment.children || [], assetsById, options).trim();
        return content ? `*${content}*` : '';
      }

      if (segment.type === 'underline') {
        const content = renderInlineMarkdown(segment.children || [], assetsById, options).trim();
        return content ? `<u>${content}</u>` : '';
      }

      if (segment.type === 'strike') {
        const content = renderInlineMarkdown(segment.children || [], assetsById, options).trim();
        return content ? `~~${content}~~` : '';
      }

      if (segment.type === 'code') {
        const content = segment.text.replace(/`/g, '\\`');
        return content ? `\`${content}\`` : '';
      }

      if (segment.type === 'mark') {
        const content = renderInlineMarkdown(segment.children || [], assetsById, options).trim();
        return content ? `<mark>${content}</mark>` : '';
      }

      if (segment.type === 'color') {
        const content = renderInlineMarkdown(segment.children || [], assetsById, options).trim();
        return content ? `<span style="color:${segment.color}">${content}</span>` : '';
      }

      return '';
    })
    .filter(Boolean)
    .join('')
    .trim();
}

function toAlphabetIndex(value) {
  let current = Math.max(1, value);
  let result = '';
  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(97 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }
  return result;
}

function toRoman(value) {
  const numerals = [
    ['m', 1000],
    ['cm', 900],
    ['d', 500],
    ['cd', 400],
    ['c', 100],
    ['xc', 90],
    ['l', 50],
    ['xl', 40],
    ['x', 10],
    ['ix', 9],
    ['v', 5],
    ['iv', 4],
    ['i', 1],
  ];
  let current = Math.max(1, value);
  let result = '';
  for (const [symbol, size] of numerals) {
    while (current >= size) {
      result += symbol;
      current -= size;
    }
  }
  return result;
}

function formatListMarker(item, counters) {
  if (item.checkable) {
    return `[${item.checked ? 'x' : ' '}]`;
  }

  if (!item.listFormat || item.listFormat === 'bullet') {
    return item.listSymbol || '-';
  }

  const next = (counters.get(item.level) || 0) + 1;
  counters.set(item.level, next);

  if (item.listFormat === 'lowerLetter') {
    return `${toAlphabetIndex(next)}.`;
  }

  if (item.listFormat === 'lowerRoman') {
    return `${toRoman(next)}.`;
  }

  return `${next}.`;
}

function renderInlineHtml(segments, assetsById) {
  return segments
    .map((segment) => {
      if (segment.type === 'text') {
        return escapeHtml(segment.text);
      }

      if (segment.type === 'break') {
        return '<br>';
      }

      if (segment.type === 'mention') {
        return escapeHtml(segment.text);
      }

      if (segment.type === 'image') {
        const asset = assetsById.get(segment.assetId);
        return asset
          ? `<img alt="${escapeHtml(asset.alt || asset.fileName)}" src="${escapeHtml(asset.markdownPath)}" style="max-width:100%;height:auto;" />`
          : '[图片]';
      }

      if (segment.type === 'link') {
        const label = renderInlineHtml(segment.children || [], assetsById).trim() || escapeHtml(segment.href);
        return `<a href="${escapeHtml(segment.href)}">${label}</a>`;
      }

      if (segment.type === 'strong') {
        return `<strong>${renderInlineHtml(segment.children || [], assetsById)}</strong>`;
      }

      if (segment.type === 'em') {
        return `<em>${renderInlineHtml(segment.children || [], assetsById)}</em>`;
      }

      if (segment.type === 'underline') {
        return `<u>${renderInlineHtml(segment.children || [], assetsById)}</u>`;
      }

      if (segment.type === 'strike') {
        return `<del>${renderInlineHtml(segment.children || [], assetsById)}</del>`;
      }

      if (segment.type === 'code') {
        return `<code>${escapeHtml(segment.text)}</code>`;
      }

      if (segment.type === 'mark') {
        return `<mark>${renderInlineHtml(segment.children || [], assetsById)}</mark>`;
      }

      if (segment.type === 'color') {
        return `<span style="color:${escapeHtml(segment.color)};">${renderInlineHtml(segment.children || [], assetsById)}</span>`;
      }

      return '';
    })
    .join('');
}

function renderBlocksAsHtml(blocks, assetsById) {
  return blocks
    .map((block) => {
      if (!block) {
        return '';
      }

      if (block.type === 'heading') {
        const level = Math.min(Math.max(block.level || 2, 1), 6);
        return `<h${level} style="margin:0 0 0.4em 0;">${renderInlineHtml(block.segments || [], assetsById)}</h${level}>`;
      }

      if (block.type === 'paragraph') {
        const marginLeft = block.indentLeft ? `${Number(block.indentLeft) / 16}em` : '0';
        return `<p style="margin:0 0 0.45em ${marginLeft};">${renderInlineHtml(block.segments || [], assetsById)}</p>`;
      }

      if (block.type === 'quote') {
        const marginLeft = block.indentLeft ? `${Number(block.indentLeft) / 16}em` : '0';
        return `<blockquote style="margin:0 0 0.45em ${marginLeft};padding-left:0.8em;border-left:3px solid #ddd;">${renderInlineHtml(block.segments || [], assetsById)}</blockquote>`;
      }

      if (block.type === 'code') {
        return `<pre style="margin:0 0 0.45em 0;white-space:pre-wrap;"><code>${escapeHtml(block.text)}</code></pre>`;
      }

      if (block.type === 'list') {
        const counters = new Map();
        return block.items
          .map((item) => {
            for (const level of Array.from(counters.keys())) {
              if (level > item.level) {
                counters.delete(level);
              }
            }

            const marker = formatListMarker(item, counters);
            return `<div style="margin:0 0 0.35em ${item.level * 1.5}em;"><span style="display:inline-block;min-width:2.2em;">${escapeHtml(marker)}</span>${renderInlineHtml(item.segments || [], assetsById)}</div>`;
          })
          .join('');
      }

      if (block.type === 'table') {
        return renderTable(block.rows, assetsById);
      }

      if (block.type === 'image') {
        const asset = assetsById.get(block.assetId);
        return asset
          ? `<p style="margin:0 0 0.45em 0;"><img alt="${escapeHtml(asset.alt || asset.fileName)}" src="${escapeHtml(asset.markdownPath)}" style="max-width:100%;height:auto;" /></p>`
          : '';
      }

      return '';
    })
    .filter(Boolean)
    .join('');
}

function renderTable(rows, assetsById) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '';
  }

  const renderCellHtml = (cell) => {
    if (cell && typeof cell === 'object' && Array.isArray(cell.blocks)) {
      return renderBlocksAsHtml(cell.blocks, assetsById) || escapeHtml(cell.text || '');
    }

    return escapeHtml(String(cell || ''));
  };

  const headerCells = rows[0]
    .map((cell) => `<th style="text-align:left;vertical-align:top;padding:8px;border:1px solid #ddd;">${renderCellHtml(cell)}</th>`)
    .join('');
  const bodyRows = rows
    .slice(1)
    .map((row) => `<tr>${row.map((cell) => `<td style="vertical-align:top;padding:8px;border:1px solid #ddd;">${renderCellHtml(cell)}</td>`).join('')}</tr>`)
    .join('');

  return `<table style="border-collapse:collapse;width:100%;margin:0 0 1em 0;"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

function renderQuoteMarkdown(segments, assetsById) {
  const content = renderInlineMarkdown(segments, assetsById).trim();
  if (!content) {
    return '';
  }

  return content
    .split('\n')
    .map((line) => `> ${line.trimEnd()}`)
    .join('\n');
}

function renderListMarkdown(block, assetsById) {
  const counters = new Map();

  return block.items
    .map((item) => {
      for (const level of Array.from(counters.keys())) {
        if (level > item.level) {
          counters.delete(level);
        }
      }

      const marker = formatListMarker(item, counters);

      const content = renderInlineMarkdown(item.segments, assetsById).trim();
      return `${'  '.repeat(item.level)}${marker} ${content}`.trimEnd();
    })
    .filter(Boolean)
    .join('\n');
}

function renderMarkdown(blocks, assetsById) {
  return blocks
    .map((block) => {
      if (!block) {
        return '';
      }

      if (block.type === 'heading') {
        const content = renderInlineMarkdown(block.segments || [], assetsById).trim();
        return content ? `${'#'.repeat(Math.min(Math.max(block.level || 2, 1), 6))} ${content}` : '';
      }

      if (block.type === 'paragraph') {
        return renderInlineMarkdown(block.segments || [], assetsById).trim();
      }

      if (block.type === 'quote') {
        return renderQuoteMarkdown(block.segments || [], assetsById);
      }

      if (block.type === 'code') {
        return `\`\`\`text\n${block.text}\n\`\`\``;
      }

      if (block.type === 'list') {
        return renderListMarkdown(block, assetsById);
      }

      if (block.type === 'table') {
        return renderTable(block.rows, assetsById);
      }

      if (block.type === 'image') {
        const asset = assetsById.get(block.assetId);
        return asset ? `![${asset.alt || asset.fileName}](${asset.markdownPath})` : `[图片 ${block.assetId}]`;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function rawTextFromBlocks(blocks) {
  return blocks
    .map((block) => {
      if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'quote') {
        return cleanInlineText(segmentsToPlainText(block.segments || []));
      }

      if (block.type === 'code') {
        return block.text;
      }

      if (block.type === 'list') {
        return block.items
          .map((item) => cleanInlineText(segmentsToPlainText(item.segments || [])))
          .filter(Boolean)
          .join('\n');
      }

      if (block.type === 'table') {
        return block.rows
          .map((row) => row.map((cell) => (cell && typeof cell === 'object' ? cell.text : String(cell || ''))).join(' | '))
          .join('\n');
      }

      if (block.type === 'image') {
        return '[图片]';
      }

      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseDocumentFromResponse(responseJson) {
  const checkpointContent = responseJson?.data?.documentContent?.checkpoint?.content;
  if (!checkpointContent) {
    throw new Error('未获取到正文数据');
  }

  const packageData = JSON.parse(checkpointContent);
  const mainPart = packageData.parts?.[packageData.main];
  if (!mainPart?.data?.body) {
    throw new Error('正文结构缺失');
  }

  const state = createParseState('content');
  const blocks = [];
  parseAstNode(mainPart.data.body, state, blocks);
  const groupedBlocks = groupListBlocks(blocks);

  return {
    rawText: rawTextFromBlocks(groupedBlocks),
    blocks: groupedBlocks,
    assets: state.assets,
  };
}

function parseCommentItem(comment) {
  const state = createParseState(`comment-${comment.commentId}`);
  const blocks = [];
  const contentTree = JSON.parse(comment.content || 'null');

  if (contentTree) {
    parseAstNode(contentTree, state, blocks);
  }

  const groupedBlocks = groupListBlocks(blocks);
  return {
    id: comment.commentId,
    author: comment.creator?.name || '',
    createdAt: comment.createTime || null,
    updatedAt: comment.updateTime || null,
    summary: cleanInlineText(comment.summary || ''),
    rawText: rawTextFromBlocks(groupedBlocks),
    blocks: groupedBlocks,
    assets: state.assets,
  };
}

function parseCommentsFromResponse(responseJson) {
  const items = responseJson?.data?.data || [];
  return items.map(parseCommentItem);
}

async function downloadAsset(url, cookieHeader) {
  const resolvedUrl = resolveSourceUrl(url);

  if (resolvedUrl.startsWith('data:')) {
    const parsed = parseDataUrl(resolvedUrl);
    return {
      buffer: parsed.buffer,
      mimeType: parsed.mimeType,
    };
  }

  const response = await fetch(resolvedUrl, {
    headers: {
      Cookie: cookieHeader,
      Referer: `${DINGTALK_ORIGIN}/`,
      'User-Agent': 'Mozilla/5.0',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: response.headers.get('content-type')?.split(';')[0]?.toLowerCase() || '',
  };
}

async function persistAssets(assets, outputDir, cookies, filePrefix) {
  const cookieHeader = buildCookieHeader(cookies);
  const assetsDir = path.join(outputDir, 'assets');
  ensureOutputDir(assetsDir);
  const savedAssets = [];

  for (let index = 0; index < assets.length; index++) {
    const asset = assets[index];
    if (!asset.sourceUrl) {
      continue;
    }

    try {
      const downloaded = await downloadAsset(asset.sourceUrl, cookieHeader);
      const ext = guessExtension(asset.sourceUrl, downloaded.mimeType);
      const fileName = `${filePrefix}-${String(index + 1).padStart(2, '0')}.${ext}`;
      const filePath = path.join(assetsDir, fileName);
      fs.writeFileSync(filePath, downloaded.buffer);

      savedAssets.push({
        ...asset,
        fileName,
        filePath,
        markdownPath: `assets/${fileName}`,
        mimeType: downloaded.mimeType,
      });
    } catch {
      // 忽略单个资源下载失败
    }
  }

  return savedAssets;
}

function assetMapFromList(assets) {
  return new Map(assets.map((asset) => [asset.id, asset]));
}

function mergeCommentAssets(commentItems, savedAssets) {
  const savedById = assetMapFromList(savedAssets);
  return commentItems.map((comment) => ({
    ...comment,
    assets: comment.assets
      .map((asset) => savedById.get(asset.id))
      .filter(Boolean)
      .map((asset) => ({
        id: asset.id,
        sourceUrl: asset.sourceUrl,
        width: asset.width,
        height: asset.height,
        markdownPath: asset.markdownPath,
      })),
  }));
}

function renderCommentsMarkdown(commentItems, assetsById) {
  if (commentItems.length === 0) {
    return '暂无评论内容';
  }

  return commentItems
    .map((comment) => {
      const header = `### ${comment.author || '未知用户'}${comment.createdAt ? ` · ${new Date(comment.createdAt).toISOString()}` : ''}`;
      const body = renderMarkdown(comment.blocks, assetsById) || comment.summary || comment.rawText || '(空评论)';
      return `${header}\n\n${body}`;
    })
    .join('\n\n');
}

function buildDocumentMarkdown(title, contentMarkdown, commentsMarkdown) {
  const parts = [`# ${title}`];

  parts.push('## 正文');
  parts.push(contentMarkdown || '暂无正文内容');

  parts.push('## 评论');
  parts.push(commentsMarkdown || '暂无评论内容');

  return `${parts.join('\n\n').trim()}\n`;
}

export async function readDocument(url, options = {}) {
  const { headless = true } = options;

  if (!url) {
    throw new Error('请提供钉钉文档URL');
  }

  console.log('🚀 开始读取文档...');
  console.log(`📄 目标URL: ${url}`);
  console.log(`🖥️ 无头模式: ${headless}`);

  const outputDir = generateOutputDir();
  ensureOutputDir(outputDir);

  const { browser, context, page } = await createBrowserSession({ headless });
  const collector = createResponseCollector(page);

  try {
    let { frame } = await openDingTalkDocument(page, url);
    const dentryInfo = await fetchDentryInfo(page, url);
    const title = cleanTitle(dentryInfo?.name || await readMetaTitle(page, frame));

    let docResponse = pickMainDocumentResponse(collector.documentResponses, frame.url());
    if (!docResponse) {
      await page.waitForTimeout(1500);
      docResponse = pickMainDocumentResponse(collector.documentResponses, frame.url());
    }

    if (!docResponse) {
      console.log('🔄 未捕获到正文接口响应，重试一次页面加载...');
      ({ frame } = await openDingTalkDocument(page, url));
      docResponse = pickMainDocumentResponse(collector.documentResponses, frame.url());
    }

    if (!docResponse) {
      throw new Error('未捕获到正文接口响应');
    }

    const content = parseDocumentFromResponse(docResponse.json);

    const commentResponse = await loadComments(page, frame, collector, dentryInfo);
    const commentItems = commentResponse ? parseCommentsFromResponse(commentResponse.json) : [];

    const cookies = await context.cookies();
    const contentAssets = await persistAssets(content.assets, outputDir, cookies, 'content');
    const flatCommentAssets = commentItems.flatMap((comment) => comment.assets);
    const commentAssets = await persistAssets(flatCommentAssets, outputDir, cookies, 'comment');

    const contentAssetsById = assetMapFromList(contentAssets);
    const mergedCommentItems = mergeCommentAssets(commentItems, commentAssets);
    const commentAssetsById = assetMapFromList(commentAssets);

    const result = {
      url,
      title,
      extractedAt: new Date().toISOString(),
      outputDir,
      metadata: dentryInfo
        ? {
            dentryUuid: dentryInfo.dentryUuid,
            dentryKey: dentryInfo.dentryKey,
            dentryId: dentryInfo.dentryId,
            docKey: dentryInfo.docKey,
            name: dentryInfo.name,
            spaceId: dentryInfo.spaceId,
          }
        : null,
      content: {
        rawText: content.rawText,
        blocks: content.blocks,
        assets: contentAssets.map((asset) => ({
          id: asset.id,
          sourceUrl: asset.sourceUrl,
          width: asset.width,
          height: asset.height,
          markdownPath: asset.markdownPath,
        })),
        markdown: renderMarkdown(content.blocks, contentAssetsById),
      },
      comments: {
        items: mergedCommentItems.map((comment) => ({
          id: comment.id,
          author: comment.author,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          summary: comment.summary,
          rawText: comment.rawText,
          blocks: comment.blocks,
          assets: comment.assets,
          markdown: renderMarkdown(comment.blocks, commentAssetsById) || comment.summary || comment.rawText,
        })),
        assets: commentAssets.map((asset) => ({
          id: asset.id,
          sourceUrl: asset.sourceUrl,
          width: asset.width,
          height: asset.height,
          markdownPath: asset.markdownPath,
        })),
      },
    };

    result.comments.rawText = result.comments.items.map((item) => item.rawText).filter(Boolean).join('\n\n');
    result.comments.markdown = renderCommentsMarkdown(result.comments.items, commentAssetsById);
    result.markdown = buildDocumentMarkdown(title, result.content.markdown, result.comments.markdown);

    writeJson(path.join(outputDir, 'document.json'), result);
    fs.writeFileSync(path.join(outputDir, 'document.md'), result.markdown);
    writeJson(path.join(outputDir, 'comments.json'), result.comments);

    console.log('\n🎉 文档读取完成！');
    console.log(`📁 输出目录: ${outputDir}`);
    console.log(`📝 Markdown: document.md`);
    console.log(`🧾 结构化结果: document.json`);

    return result;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const visibleFlag = args.includes('--visible') || args.includes('-v');
  const url = args.find((arg) => !arg.startsWith('-'));

  if (!url) {
    console.error('用法: node src/read.js <钉钉文档URL> [--visible]');
    console.error('  --visible, -v  以可见模式运行浏览器（用于调试）');
    process.exit(1);
  }

  readDocument(url, { headless: !visibleFlag })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('❌ 读取失败:', error.message);
      process.exit(1);
    });
}
