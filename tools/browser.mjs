/**
 * 无头浏览器查找（Windows / Linux / macOS 三平台一处维护）。
 *
 * 以前每个测试脚本都抄一份候选路径，只写 Windows —— CI（ubuntu-latest 自带 Chrome）
 * 一跑就说「找不到浏览器」，于是浏览器 E2E 永远上不了 CI。
 *
 * 优先级：CHROME 环境变量 → PUPPETEER_EXECUTABLE_PATH → 各平台常见安装路径。
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

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

/**
 * 无头 Chrome 的统一启动参数。
 *
 * `--disable-dev-shm-usage` 是给 CI 的：GitHub runner 的 /dev/shm 只有 64 MB，
 * 不加这条渲染进程会莫名其妙崩掉，表现就是「DevTools 端口没能启动」这种看不出原因的红。
 */
export const CHROME_FLAGS = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  '--disable-background-networking',
];

/** 拼出完整的参数表（端口 + 独立 profile + about:blank 收尾） */
export function chromeArgs({ port, profile, extra = [] }) {
  return [...CHROME_FLAGS, '--remote-debugging-port=' + port, '--user-data-dir=' + profile, ...extra, 'about:blank'];
}

/**
 * 收尾杀进程：只杀自己 spawn 的那棵子树。
 *
 * Windows 用 taskkill /T /F；Linux/macOS 用 SIGKILL（子进程一般是直接 spawn 的，
 * 没有独立进程组，所以按 pid 杀即可）。**必须吞掉 spawn 的 error 事件**：
 * 以前 pwa-test 在 Linux 上直接 spawn('taskkill')，ENOENT 冒成 unhandled 'error'，
 * 断言全过了却因为收尾崩溃而以 1 退出——CI 上就是这么红的。
 */
export function killTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const p = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    p.on('error', () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退了 */
      }
    });
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已经退了 */
  }
}
