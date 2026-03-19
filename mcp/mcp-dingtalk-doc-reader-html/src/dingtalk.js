import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadStorageState } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const OUTPUT_DIR = path.join(__dirname, '../output');
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
export const CONTENT_SCROLL_SELECTOR = '#layout_body';

const CONTENT_SELECTORS = [
  '#content-wrapper',
  '#main-area-wrapper',
  '.body-editor-content',
  '.lake-content',
  '.ne-viewer-body',
  '[class*="editor-content"]',
  '#layout_body',
];

const COMMENT_PANEL_SELECTORS = [
  '.new-comment-wrapper',
  '[class*="new-comment-wrapper"]',
  '[class*="comment-wrapper"]',
  '[class*="CommentWrapper"]',
  '.comment-panel',
  '.ne-comment-panel',
  '[class*="comment-panel"]',
  '[class*="comment-list"]',
  '[class*="comments-container"]',
  '[class*="comment-sidebar"]',
  '[class*="CommentPanel"]',
  '[class*="CommentList"]',
  '[class*="comment-drawer"]',
  '[class*="CommentDrawer"]',
  '[class*="review-panel"]',
  '[class*="ReviewPanel"]',
  '.lake-comment-panel',
  '.lake-comments',
  '[data-lake-card="comment"]',
  '.ne-comments',
  '.ne-comment-list',
];

const COMMENT_BUTTON_SELECTORS = [
  '[data-testid="comment"]',
  '.comment-icon',
  '[class*="comment-btn"]',
  '[class*="comment-button"]',
  '[title*="评论"]',
  '[aria-label*="评论"]',
  '[aria-label*="comment"]',
  '[class*="CommentBtn"]',
  '[class*="CommentButton"]',
  '[class*="comment-trigger"]',
  '[class*="CommentTrigger"]',
  'button[class*="comment"]',
  '[data-action="comment"]',
  '.lake-comment-btn',
  '.ne-comment-btn',
];

const HIDE_MAIN_UI_CSS = `
  #collapsable-container,
  .collapsable-container,
  [class*="collapsable-container"] {
    display: none !important;
  }

  .reactive-content-column-container {
    margin-left: 0 !important;
    width: 100% !important;
  }

  [class*="modal"],
  [class*="Modal"],
  [class*="dialog"],
  [class*="Dialog"],
  [class*="popup"],
  [class*="Popup"],
  [class*="toast"],
  [class*="Toast"],
  [class*="notification"],
  [class*="Notification"],
  [class*="overlay"],
  [class*="Overlay"],
  [class*="mask"],
  [class*="Mask"],
  [class*="banner"],
  [class*="Banner"],
  .ant-modal,
  .ant-modal-mask,
  .ant-notification,
  .ant-message,
  .ant-popover,
  .ant-tooltip,
  [role="dialog"],
  [role="alertdialog"],
  [role="tooltip"] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
  }
`;

const HIDE_IFRAME_UI_CSS = `
  [class*="top-navigation-bar"],
  [class*="navigation-bar"],
  [class*="header-bar"],
  [class*="HeaderBar"],
  [class*="top-bar"],
  [class*="TopBar"],
  .sc-jxBefZ,
  .sc-jRPRqf {
    display: none !important;
  }

  [class*="modal"],
  [class*="Modal"],
  [class*="dialog"],
  [class*="Dialog"],
  [class*="popup"],
  [class*="Popup"],
  [class*="toast"],
  [class*="Toast"],
  [class*="notification"],
  [class*="Notification"],
  [class*="overlay"],
  [class*="Overlay"],
  [class*="mask"],
  [class*="Mask"],
  [class*="banner"],
  [class*="Banner"],
  [class*="tip"],
  [class*="Tip"],
  [class*="guide"],
  [class*="Guide"],
  .ant-modal,
  .ant-modal-mask,
  .ant-notification,
  .ant-message,
  .ant-popover,
  .ant-tooltip,
  [role="dialog"],
  [role="alertdialog"],
  [role="tooltip"] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
  }

  #layout_body {
    top: 0 !important;
    margin-top: 0 !important;
  }
`;

export function generateOutputDir() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(OUTPUT_DIR, timestamp);
}

export function ensureOutputDir(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
}

export async function createBrowserSession(options = {}) {
  const { headless = true } = options;
  const storageState = loadStorageState();
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    deviceScaleFactor: 2,
    storageState,
  });
  const page = await context.newPage();
  return { browser, context, page };
}

export async function waitForAuthorizedDocument(page) {
  console.log('⏳ 等待页面渲染...');
  await page.waitForTimeout(4000);

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const currentUrl = page.url().toLowerCase();
    if (currentUrl.includes('login') || currentUrl.includes('passport')) {
      throw new Error('登录态已失效，请重新运行 npm run login');
    }

    if (!currentUrl.includes('authorize') && !currentUrl.includes('oauth')) {
      return;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error('等待钉钉授权超时');
}

export async function waitForDocFrame(page) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const url = frame.url();
      if (url.includes('/note/edit') || url.includes('/doc/')) {
        console.log(`✅ 找到文档 iframe: ${url.slice(0, 80)}...`);
        return frame;
      }
    }

    await page.waitForTimeout(1000);
  }

  return null;
}

export async function injectCleanupStyles(page, frame) {
  await page.addStyleTag({ content: HIDE_MAIN_UI_CSS });
  await frame.addStyleTag({ content: HIDE_IFRAME_UI_CSS });
}

export async function dismissPopupsInFrame(frame) {
  const closeButtonSelectors = [
    '[class*="close"]',
    '[class*="Close"]',
    '[aria-label*="关闭"]',
    '[aria-label*="close"]',
    '[title*="关闭"]',
    '[title*="close"]',
    'button[class*="dismiss"]',
    '[class*="icon-close"]',
    '.anticon-close',
    '[data-testid*="close"]',
  ];

  let closedCount = 0;

  for (const selector of closeButtonSelectors) {
    try {
      const buttons = await frame.locator(selector).all();
      for (const button of buttons) {
        const visible = await button.isVisible().catch(() => false);
        if (!visible) {
          continue;
        }

        await button.click({ timeout: 1000 }).catch(() => {});
        closedCount++;
      }
    } catch {
      // 忽略偶发定位失败
    }
  }

  try {
    await frame.press('body', 'Escape');
  } catch {
    // 忽略
  }

  if (closedCount > 0) {
    console.log(`✅ 关闭了 ${closedCount} 个弹窗/提示`);
  }
}

export async function prepareDocFrame(page, frame) {
  await injectCleanupStyles(page, frame);
  await dismissPopupsInFrame(frame);
  await page.waitForTimeout(500);
  await injectCleanupStyles(page, frame);
}

export async function findFirstVisibleSelector(frame, selectors, minWidth = 100, minHeight = 50) {
  for (const selector of selectors) {
    try {
      const handles = await frame.locator(selector).all();
      for (const handle of handles) {
        const box = await handle.boundingBox().catch(() => null);
        if (box && box.width >= minWidth && box.height >= minHeight) {
          console.log(`✅ 命中选择器: ${selector} (${Math.round(box.width)}x${Math.round(box.height)})`);
          return selector;
        }
      }
    } catch {
      // 忽略动态节点导致的异常
    }
  }

  return null;
}

export async function findContentSelector(frame) {
  const selector = await findFirstVisibleSelector(frame, CONTENT_SELECTORS, 300, 120);
  return selector || CONTENT_SCROLL_SELECTOR;
}

export async function findCommentPanelSelector(frame) {
  return findFirstVisibleSelector(frame, COMMENT_PANEL_SELECTORS, 120, 80);
}

export async function findCommentButtonSelector(frame) {
  let fallbackSelector = null;

  for (const selector of COMMENT_BUTTON_SELECTORS) {
    const locator = frame.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      continue;
    }

    if (!fallbackSelector) {
      fallbackSelector = selector;
    }

    const visible = await locator.isVisible().catch(() => false);
    if (visible) {
      console.log(`✅ 找到评论按钮: ${selector}`);
      return selector;
    }
  }

  if (fallbackSelector) {
    console.log(`✅ 找到评论按钮（使用存在即点击兜底）: ${fallbackSelector}`);
  }

  return fallbackSelector;
}

async function findExistingSelector(frame, selectors) {
  for (const selector of selectors) {
    const count = await frame.locator(selector).count().catch(() => 0);
    if (count > 0) {
      return selector;
    }
  }

  return null;
}

export async function ensureCommentPanel(page, frame) {
  let commentPanelSelector = await findCommentPanelSelector(frame);
  if (!commentPanelSelector) {
    const commentButtonSelector = await findCommentButtonSelector(frame);
    if (commentButtonSelector) {
      console.log('🖱️ 点击评论按钮...');
      await frame.locator(commentButtonSelector).first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(1500);
      commentPanelSelector = await findCommentPanelSelector(frame);
      if (!commentPanelSelector) {
        commentPanelSelector = await findExistingSelector(frame, COMMENT_PANEL_SELECTORS);
      }
    }
  }

  return commentPanelSelector;
}

export async function scrollToLoadAllInFrame(frame, selector = CONTENT_SCROLL_SELECTOR) {
  console.log('📜 滚动页面触发懒加载...');

  const info = await frame.evaluate(async (scrollerSelector) => {
    const scroller =
      document.querySelector(scrollerSelector) ||
      document.scrollingElement ||
      document.documentElement;

    const step = Math.max(400, Math.floor((scroller.clientHeight || window.innerHeight) * 0.7));
    let maxObservedHeight = scroller.scrollHeight;
    let current = 0;
    let passes = 0;

    while (current < scroller.scrollHeight) {
      scroller.scrollTo(0, current);
      await new Promise((resolve) => setTimeout(resolve, 350));
      maxObservedHeight = Math.max(maxObservedHeight, scroller.scrollHeight);
      current += step;
      passes++;
    }

    scroller.scrollTo(0, scroller.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 600));
    scroller.scrollTo(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 400));

    return {
      scrollHeight: maxObservedHeight,
      clientHeight: scroller.clientHeight || window.innerHeight,
      passes,
    };
  }, selector);

  console.log(`📐 内容高度: ${info.scrollHeight}px, 视口高度: ${info.clientHeight}px, 滚动次数: ${info.passes}`);
}

export async function openDingTalkDocument(page, url) {
  console.log('🌐 正在加载文档...');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForAuthorizedDocument(page);

  const frame = await waitForDocFrame(page);
  if (!frame) {
    throw new Error('未找到文档 iframe');
  }

  await prepareDocFrame(page, frame);
  const contentSelector = await findContentSelector(frame);

  return { frame, contentSelector };
}
