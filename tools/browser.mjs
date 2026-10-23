/**
 * 无头浏览器查找（Windows / Linux / macOS 三平台一处维护）。
 *
 * 以前每个测试脚本都抄一份候选路径，只写 Windows —— CI（ubuntu-latest 自带 Chrome）
 * 一跑就说「找不到浏览器」，于是浏览器 E2E 永远上不了 CI。
 *
 * 优先级：CHROME 环境变量 → PUPPETEER_EXECUTABLE_PATH → 各平台常见安装路径。
 */
import { existsSync } from 'node:fs';

export const BROWSER_CANDIDATES = [
  process.env.CHROME,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  // Windows
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  // Linux（GitHub Actions 的 ubuntu-latest 自带 google-chrome）
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
].filter(Boolean);

/** 找到就返回路径，找不到返回 null（不抛错，方便调用方决定「跳过」还是「失败」） */
export function findBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* 路径不可读就当没有 */
    }
  }
  return null;
}

/** 找不到直接退出：给「必须跑浏览器」的脚本用 */
export function requireBrowser() {
  const exe = findBrowser();
  if (!exe) {
    console.error('找不到 Chrome / Edge；可用 CHROME 环境变量指定可执行文件路径');
    console.error('已尝试：' + BROWSER_CANDIDATES.join(' , '));
    process.exit(1);
  }
  return exe;
}
