import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const AUTH_DIR = path.join(__dirname, '../auth');
export const STATE_FILE = path.join(AUTH_DIR, 'state.json');
export const COOKIES_FILE = path.join(AUTH_DIR, 'cookies.json');
export const STORAGE_FILE = path.join(AUTH_DIR, 'storage.json');

const RELEVANT_COOKIE_NAMES = ['doc_atoken', 'account', 'token', 'session', 'xsrf-token'];
const DEFAULT_ORIGIN = 'https://alidocs.dingtalk.com';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function isCookieExpired(cookie, nowSeconds) {
  return typeof cookie.expires === 'number' && cookie.expires !== -1 && cookie.expires <= nowSeconds;
}

function hasRelevantCookies(cookies) {
  const nowSeconds = Date.now() / 1000;
  return cookies.some((cookie) => {
    if (isCookieExpired(cookie, nowSeconds)) {
      return false;
    }

    const name = String(cookie.name || '').toLowerCase();
    return RELEVANT_COOKIE_NAMES.some((keyword) => name.includes(keyword));
  });
}

function normalizeOrigins(origins) {
  if (!Array.isArray(origins)) {
    return [];
  }

  return origins
    .filter((originEntry) => originEntry && originEntry.origin && Array.isArray(originEntry.localStorage))
    .map((originEntry) => ({
      origin: originEntry.origin,
      localStorage: originEntry.localStorage.filter(
        (item) => item && typeof item.name === 'string' && typeof item.value === 'string'
      ),
    }));
}

export function ensureAuthDir() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

export function hasUsableAuthState() {
  try {
    const state = loadStorageState();
    return hasRelevantCookies(state.cookies || []);
  } catch {
    return false;
  }
}

export function loadStorageState() {
  if (fs.existsSync(STATE_FILE)) {
    const state = readJson(STATE_FILE);
    if (!Array.isArray(state.cookies)) {
      throw new Error('state.json 格式无效');
    }

    return {
      cookies: state.cookies,
      origins: normalizeOrigins(state.origins),
    };
  }

  if (!fs.existsSync(COOKIES_FILE)) {
    throw new Error('未找到登录态，请先运行 npm run login 完成扫码登录');
  }

  const cookies = readJson(COOKIES_FILE);
  let storage = {};

  if (fs.existsSync(STORAGE_FILE)) {
    try {
      storage = readJson(STORAGE_FILE);
    } catch {
      storage = {};
    }
  }

  const localStorage = Object.entries(storage).map(([name, value]) => ({
    name,
    value: String(value),
  }));

  return {
    cookies,
    origins: localStorage.length > 0 ? [{ origin: DEFAULT_ORIGIN, localStorage }] : [],
  };
}

export async function saveStorageState(context, currentUrl = DEFAULT_ORIGIN) {
  ensureAuthDir();

  await context.storageState({ path: STATE_FILE });

  const state = readJson(STATE_FILE);
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(state.cookies || [], null, 2));

  const origin = new URL(currentUrl).origin;
  const matchedOrigin =
    (state.origins || []).find((entry) => entry.origin === origin) ||
    (state.origins || []).find((entry) => entry.origin === DEFAULT_ORIGIN) ||
    state.origins?.[0];

  const storageObject = Object.fromEntries(
    (matchedOrigin?.localStorage || []).map((item) => [item.name, item.value])
  );

  fs.writeFileSync(STORAGE_FILE, JSON.stringify(storageObject, null, 2));
}
