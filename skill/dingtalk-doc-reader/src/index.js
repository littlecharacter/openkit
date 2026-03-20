/**
 * 钉钉文档工具 - 主入口
 * 支持登录认证和结构化读取
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { hasUsableAuthState } from './auth.js';
import { readDocument } from './read.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 等待登录完成
 */
async function waitForLogin(url) {
  console.log('⚠️ 未检测到登录态，启动扫码登录...\n');

  const loginProcess = spawn('node', [path.join(__dirname, 'login.js'), url], {
    stdio: 'inherit'
  });

  return new Promise((resolve, reject) => {
    loginProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error('登录失败'));
      }
    });
  });
}

export async function main() {
  const url = process.argv[2];

  if (!url) {
    console.log('用法: npm run start -- <钉钉文档URL>');
    console.log('');
    console.log('示例:');
    console.log('  npm run start -- https://alidocs.dingtalk.com/i/nodes/xxx');
    console.log('');
    console.log('功能: 自动检测登录态，然后读取文档正文、评论和图片资源');
    return;
  }

  // 检查登录态
  if (!hasUsableAuthState()) {
    await waitForLogin(url);
  }

  // 验证登录态存在
  if (!hasUsableAuthState()) {
    console.error('❌ 登录失败，请重试');
    process.exit(1);
  }

  try {
    await readDocument(url);
  } catch (error) {
    if (error.message.includes('登录态已失效')) {
      console.log('⚠️ 当前登录态已失效，尝试重新登录...\n');
      await waitForLogin(url);
      await readDocument(url);
      return;
    }

    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('❌ 执行失败:', err.message);
    process.exit(1);
  });
}
