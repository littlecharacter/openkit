/**
 * 钉钉扫码登录 - 保存登录态
 */
import { chromium } from 'playwright';
import { ensureAuthDir, saveStorageState } from './auth.js';

const DOC_URL = process.argv[2] || 'https://alidocs.dingtalk.com';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_INTERVAL_MS = 1500;

function isLikelyLoggedIn(url, cookies) {
  const normalizedUrl = String(url || '').toLowerCase();
  const blockedKeywords = ['login', 'passport', 'oauth', 'authorize'];

  if (blockedKeywords.some((keyword) => normalizedUrl.includes(keyword))) {
    return false;
  }

  return cookies.some((cookie) => {
    const name = String(cookie.name || '').toLowerCase();
    return (
      name.includes('doc_atoken') ||
      name.includes('account') ||
      name.includes('token') ||
      name.includes('session') ||
      name.includes('xsrf-token')
    );
  });
}

async function login() {
  ensureAuthDir();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('🚀 正在打开登录页面...');
  // 使用 domcontentloaded 避免网络请求过多导致的超时
  await page.goto(DOC_URL, { waitUntil: 'domcontentloaded' });

  console.log('\n' + '='.repeat(40));
  console.log('请在浏览器中完成扫码登录');
  console.log('一旦登录成功，脚本将自动保存状态并退出');
  console.log('='.repeat(40) + '\n');

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const cookies = await context.cookies();
      const currentUrl = page.url();

      if (isLikelyLoggedIn(currentUrl, cookies)) {
        console.log('✅ 检测到有效登录态！正在保存...');
        await saveStorageState(context, currentUrl);
        console.log('📦 状态保存完成，正在关闭浏览器...');
        await browser.close();
        process.exit(0);
      }
    } catch {
      // 忽略轮询过程中的短暂错误
    }

    await page.waitForTimeout(LOGIN_POLL_INTERVAL_MS);
  }

  console.error('❌ 登录超时，请重新运行脚本');
  await browser.close();
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  login().catch(async (error) => {
    console.error('❌ 登录失败:', error.message);
    process.exit(1);
  });
}

export { login };
