/**
 * 界面走查：真浏览器里看关键页面有没有溢出、错位、按钮被挤成竖排
 *
 * 样式问题看图比看代码靠谱，代码里的 class 名不代表渲染结果正确。
 * 这里既截图（给人看）也做几何断言（给 CI 跑）：
 *   - 横向溢出（出现左右滑动 = 布局崩了）
 *   - 按钮高度异常（文字在方形按钮里折成两行）
 *   - 控制台报错
 *
 * 跑法：node scripts/verify-ui.mjs [--keep]
 *   --keep 跑完不删临时目录，方便翻截图（存到系统临时目录）
 *
 * 依赖本机 chromium 系浏览器 + 能上网（详情页/章节页会真的抓包子漫画）。
 * 不进 npm test：CI 上没有浏览器也没有外网，只会假失败。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 8895;
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = process.argv.includes('--keep');

const PLUGIN_PATH = join(ROOT, 'baozimh-plugin.json');

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const tmp = mkdtempSync(join(tmpdir(), 'zeno-ui-'));
const shots = join(tmp, 'shots');
mkdirSync(shots);

const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: join(tmp, 'ui.db'),
    ALLOWED_HOSTS: '',
    SYNC_TOKEN: '',
    DIST_DIR: join(ROOT, 'dist'),
  },
});

const found = findBrowser();
if (!found) {
  console.error('找不到可用的浏览器，无法走查界面');
  srv.kill();
  process.exit(2);
}

/**
 * 等图片真的解码出来。
 *
 * 只看 naturalWidth 的瞬间值会误判 —— DOM 里 <img> 早就在了，
 * 图还在网上躺着。等不到才算失败，并且把 src 一起报出来。
 */
async function waitImage(sel, ms = 30_000) {
  const ok = await page
    .waitForFunction(
      (s) => {
        const i = document.querySelector(s);
        return !!i && i.complete && i.naturalWidth > 0;
      },
      sel,
      { timeout: ms },
    )
    .then(() => true)
    .catch(() => false);
  const info = await page.evaluate((s) => {
    const i = document.querySelector(s);
    return i ? { w: i.naturalWidth, src: (i.currentSrc || i.src).slice(0, 70) } : null;
  }, sel);
  return { ok, info };
}

/** 溢出检查：文档宽度不该超过视口，超过就是布局崩了 */
const overflow = () =>
  page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }));

const geometry = (sel) =>
  page.evaluate((s) => {
    const els = [...document.querySelectorAll(s)];
    return els.map((e) => {
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), text: (e.textContent ?? '').trim().slice(0, 10) };
    });
  }, sel);

async function visit(path, name, opts = {}) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: opts.timeout ?? 60_000 });
  else await page.waitForTimeout(600);
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: !!opts.fullPage });
  const o = await overflow();
  check(o.scrollW <= o.innerW + 1, `${path} 无横向溢出（${o.scrollW} ≤ ${o.innerW}）`);
  return o;
}

console.log('\n=== 0. 起隔离服务端，导入真插件 ===');
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 150));
}

/*
 * 直接推插件而不是用界面导入 —— 导入要走文件选择器，那是浏览器能力而不是本次要验的东西。
 * 顺带让服务端的抓取白名单跟着插件走。
 *
 * 走查要有内容才有意义（空书架和装了插件的书架是两个完全不同的界面），
 * 所以插件文件在就导入；没有就退化成"空态走查"。
 */
let pluginId = '';
if (existsSync(PLUGIN_PATH)) {
  const p = JSON.parse(readFileSync(PLUGIN_PATH, 'utf8'));
  pluginId = p.meta.id;
  const res = await fetch(`${BASE}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'ui',
      seq: 0,
      plugins: [{ id: p.meta.id, origin: 'imported', data: JSON.stringify(p), updatedAt: Date.now() }],
    }),
  });
  console.log('  插件已推入，白名单：', (await res.json()).allowedHosts?.join(', '));
} else {
  console.log(`  没找到 ${PLUGIN_PATH}，只走查空态`);
}

const errors = [];
const ctx = await chromium.launchPersistentContext(join(tmp, 'profile'), {
  executablePath: found.exe,
  headless: true,
  viewport: { width: 390, height: 844 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

console.log('\n=== 1. 手机宽度（390）逐页走查 ===');
await visit('/shelf', 'shelf-390');
await visit('/explore', 'explore-390', { waitFor: '.card', timeout: 90_000 });
/*
 * 封面是不是"真的显示出来了"只能问渲染结果：
 * naturalWidth 为 0 意味着 <img> 在但图没到位 —— 代理没放行、
 * 或者插件的 cover 正则抓到一个不存在的地址。光看布局发现不了。
 */
const cardCover = await waitImage('.card__cover img');
check(cardCover.ok, `发现页封面已加载 ${JSON.stringify(cardCover.info)}`);
await visit('/search', 'search-390');
/*
 * 设置页分栏之后，插件列表在「内容源」那一栏里（/settings 默认落在外观）。
 * 要等首轮同步把插件从服务端拉下来才有内容可看，所以给 .plugin-row 留足
 * 等待时间而不是固定睡 600ms。分栏本身由 verify-settings.mjs 逐栏走查。
 */
await visit('/settings?tab=sources', 'settings-390', {
  waitFor: pluginId ? '.plugin-row' : '.empty',
  timeout: 30_000,
});

/* 插件行的操作按钮：方形 icon-btn 里塞两个汉字会被折成竖排两行，
   换成图标之后高度应接近单个按钮（38 左右）而不是两倍 */
const btns = await geometry('.plugin-row__actions .icon-btn');
if (btns.length) {
  check(
    btns.every((b) => b.h <= 44),
    `插件行按钮没有被挤高（高度 ${btns.map((b) => b.h).join('/')}）`,
  );
  check(
    btns.every((b) => b.text.length <= 1),
    `插件行按钮里是图标不是文字（内容 "${btns.map((b) => b.text).join(',')}"）`,
  );
}

console.log('\n=== 2. 详情页与阅读器 ===');
/*
 * 需要真插件才能进详情页。没推插件时这步跳过 ——
 * 走查的目标是布局，不是抓站点。
 */
if (pluginId) {
  /*
   * 从探索页点进去拿 slug，而不是自己编一个 ——
   * slug 是插件解析出来的，编的那本在这站上不存在，进详情页只会拿到错误页。
   */
  await page.goto(`${BASE}/explore`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card', { timeout: 90_000 });
  await page.locator('.card').first().click();
  await page.waitForURL(/\/comic\//, { timeout: 20_000 });
  const detailPath = new URL(page.url()).pathname;

  await page.waitForSelector('.detail__actions button', { timeout: 90_000 }).catch(() => {});
  await page.screenshot({ path: join(shots, 'detail.png'), fullPage: true });
  const od = await overflow();
  check(od.scrollW <= od.innerW + 1, `详情页无横向溢出（${od.scrollW} ≤ ${od.innerW}）`);
  const acts = await geometry('.detail__actions .btn');
  check(acts.length === 0 || acts.every((b) => b.h <= 52), `详情页按钮没被挤成竖排（${acts.map((b) => b.h).join('/')}）`);
  const detailCover = await waitImage('.detail__cover');
  check(detailCover.ok, `详情页封面已加载 ${JSON.stringify(detailCover.info)}`);

  /* 进阅读器，打开「显示设置」看翻页方向那一行 */
  await page.locator('.chapter-row, .chapter-item').first().click().catch(() => {});
  await page.waitForURL(/\/read\//, { timeout: 20_000 }).catch(() => {});
  if (/\/read\//.test(page.url())) {
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(shots, 'reader.png') });
    const or_ = await overflow();
    check(or_.scrollW <= or_.innerW + 1, '阅读器无横向溢出');
    /*
     * 工具条会自己收起（transform 移出视口），那时 Playwright 的 click 会一直重试。
     * 面板本身是覆盖层，直接派发点击更稳，也更接近"用户点了齿轮"这件事的结果。
     */
    await page.mouse.click(195, 420);
    await page.waitForTimeout(400);
    const opened = await page.evaluate(() => {
      const b = document.querySelector('[aria-label="阅读设置"]');
      if (!b) return false;
      b.click();
      return true;
    });
    check(opened, '阅读器工具条上有「阅读设置」入口');
    await page.waitForSelector('.prefs-hint', { timeout: 5_000 }).catch(() => {});

    /*
     * 「翻页方向」那一行只在分页模式下存在 —— 默认是竖向滚动，
     * 不先切模式就去找那一行，找不到的是脚本而不是界面。
     */
    await page.getByText('左右翻页', { exact: true }).first().click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'prefs-sheet.png') });
    /* 换方向时图标要跟着换（箭头指向"下一页在哪边"），不能是个静止的装饰 */
    const dirSvg = () =>
      page.evaluate(() => {
        const row = [...document.querySelectorAll('button')].find((e) =>
          e.textContent?.includes('翻页方向'),
        );
        return row?.querySelector('svg')?.innerHTML ?? '';
      });
    const before = await dirSvg();
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((e) => e.textContent?.includes('翻页方向'))
        ?.click();
    });
    await page.waitForTimeout(400);
    const after = await dirSvg();
    check(before.length > 0 && before !== after, '点一下「翻页方向」，图标跟着换了方向');
    await page.screenshot({ path: join(shots, 'prefs-sheet-flipped.png') });
  } else {
    console.log('  （没能从详情页跳进阅读器，跳过阅读器检查）');
  }
} else {
  console.log('  跳过（没装插件）');
}

console.log('\n=== 3. 平板宽度（820） ===');
await page.setViewportSize({ width: 820, height: 1180 });
await visit('/shelf', 'shelf-820');
await visit('/settings', 'settings-820');

console.log('\n=== 4. 控制台 ===');
check(errors.length === 0, `无浏览器报错${errors.length ? `：\n   - ${errors.slice(0, 6).join('\n   - ')}` : ''}`);

console.log(`\n截图在 ${shots}`);
await ctx.close();
srv.kill();
await new Promise((r) => setTimeout(r, 300));
if (!KEEP) rmSync(tmp, { recursive: true, force: true });
else console.log(`（--keep：临时目录保留 ${tmp}）`);

console.log(fails === 0 ? '\n界面走查通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
