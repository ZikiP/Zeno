/**
 * 底部进度条：细条 ⇄ 可拖的大条
 *
 * 这一档全是"看画面才知道"的事，纯函数测不到：
 *   1. 点底部**不该**呼出菜单（那是这次改动的整个前提），菜单弹了就是热区没接管；
 *   2. 拖动要**实时**跳页，不是松手才跳；
 *   3. 一秒不动要自己缩回去，滑块跟着消失；
 *   4. 中间得有形变过程 —— 只有"收起/展开"两个终态、中间一帧跳过去，
 *      看着就是换了个东西而不是长出来；
 *   5. 最右端松手 = 下一章这条老规则还在（改 onSeek 语义时最容易顺手弄丢）。
 *
 * 跑法：node scripts/verify-progress-scrub.mjs
 * 不进 npm test：要真浏览器 + 外网。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 8889;
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN = 'baozimh';
const SLUG = 'woduzishengji-duburedicestudio';
const CHAPTER = '0_113';
const SHOTS = join(ROOT, 'dist/progress');

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const found = findBrowser();
const tmp = mkdtempSync(join(tmpdir(), 'zeno-scrub-'));
mkdirSync(SHOTS, { recursive: true });
const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(tmp, 's.db'), ALLOWED_HOSTS: '', SYNC_TOKEN: '', DIST_DIR: join(ROOT, 'dist') },
});
await new Promise((r) => setTimeout(r, 1500));

const plugin = JSON.parse(readFileSync(join(ROOT, 'baozimh-plugin.json'), 'utf8'));
await fetch(`${BASE}/api/sync/push`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceId: 'scrub', seq: 0, plugins: [{ id: plugin.meta.id, origin: 'imported', data: JSON.stringify(plugin), updatedAt: Date.now() }] }),
});

const browser = await chromium.launch({ executablePath: found.exe, headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 160)}`));

await page.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.evaluate(
  (item) =>
    new Promise((res, rej) => {
      const o = indexedDB.open('zeno-reader');
      o.onsuccess = () => {
        const tx = o.result.transaction('plugins', 'readwrite');
        tx.objectStore('plugins').put(item);
        tx.oncomplete = () => res(1);
        tx.onerror = () => rej(tx.error);
      };
      o.onerror = () => rej(o.error);
    }),
  { id: plugin.meta.id, plugin, installedAt: Date.now(), updatedAt: Date.now(), origin: 'imported' },
);
await page.goto(`${BASE}/read/${PLUGIN}/${SLUG}/${CHAPTER}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.reader__progress', { timeout: 60_000 });
await page.waitForTimeout(3000);

/** 大条那块的几何 + 状态 */
const seekBox = () =>
  page.evaluate(() => {
    const wrap = document.querySelector('.reader__progress');
    const bar = document.querySelector('.reader__seek');
    const thumb = document.querySelector('.reader__progress-thumb');
    if (!wrap || !bar || !thumb) return null;
    const wb = wrap.getBoundingClientRect();
    const bb = bar.getBoundingClientRect();
    return {
      open: wrap.classList.contains('is-open'),
      /** 热区高度：手指按得准不准就看这个 */
      hitH: Math.round(wb.height),
      barH: +bb.height.toFixed(1),
      barBottom: Math.round(wb.bottom - bb.bottom),
      thumbScale: getComputedStyle(thumb).transform,
      thumbVisible: getComputedStyle(thumb).opacity !== '0',
    };
  });

const scrollTop = () => page.evaluate(() => Math.round(document.querySelector('.reader__scroll')?.scrollTop ?? -1));
const menuHidden = () => page.evaluate(() => document.querySelector('.reader__bar')?.className.includes('hide') ?? false);

console.log('\n=== 1. 收起态 ===');
const flat = await seekBox();
check(!!flat, '进度条挂上了');
check(flat && !flat.open, '一开始是收起的');
check(flat && flat.hitH >= 44, `底部热区 ${flat?.hitH}px（原来 18px，手指按不准）`);
check(flat && flat.barH <= 3.5 && !flat.thumbVisible, `收起时只有 ${flat?.barH}px 的线，滑块不可见`);
await page.screenshot({ path: join(SHOTS, '1-flat.png'), clip: { x: 0, y: 640, width: 390, height: 204 } });

console.log('\n=== 2. 点底部：呼出大条，但不呼出菜单 ===');
/*
 * 顶栏一进阅读器就是开着的（useToolbarVisibility 的初值是 true），
 * 所以"没被呼出"这句必须先把它关掉再验，否则测的是初始状态而不是这次点击。
 * 点正文中间那一下是它自己的开关，正好用来归零。
 */
await page.mouse.click(195, 420);
await page.waitForTimeout(400);
check(await menuHidden(), '先确认菜单已经收起来（点正文中间关掉的），下面才谈"点底部会不会把它呼出"');

const cx = 195;
const cy = 844 - 10;
await page.mouse.move(cx, cy);
await page.mouse.down();
/*
 * 展开动画中途连采几次：只读一帧会赶在样式生效之前，量到 3px 不代表没有过渡。
 * 要的是"确实路过中间尺寸"——只有 3 和 46 两个终态就是换了一块，不是长出来。
 */
const mids = [];
for (let i = 0; i < 12; i++) {
  const s = await seekBox();
  if (s) mids.push(s.barH);
  await page.waitForTimeout(30);
}
await page.waitForTimeout(400);
const big = await seekBox();
const between = mids.filter((h) => h > 4 && h < 45);
check(between.length > 0, `展开路上采到 ${mids.length} 帧，其中 ${between.length} 帧是中间尺寸（${between.slice(0, 4).join('→')}${between.length > 4 ? '…' : ''}）`);
check(big && big.open, '按下去就展开了');
check(big && Math.abs(big.barH - 46) < 1.5, `大条高 ${big?.barH}px`);
check(big && big.barBottom >= 20, `大条从底边上浮 ${big?.barBottom}px，底下留了缝`);
check(big && big.thumbVisible, '滑块出现了');
check(await menuHidden(), '顶栏菜单没被呼出（点底部归进度条，不归"点任意处开关菜单"）');
await page.screenshot({ path: join(SHOTS, '2-open.png'), clip: { x: 0, y: 640, width: 390, height: 204 } });

await page.mouse.up();
await page.waitForTimeout(1200);
check(!(await seekBox())?.open, '抬手停一秒，自己收回（下面几步都从收起态开始）');

console.log('\n=== 2b. 菜单开着时点底部：不该两个悬浮件叠在一起 ===');
/* 大条浮在离底 26px，正好是「上一章/下一章」那颗胶囊的位置 */
await page.mouse.click(195, 420);
await page.waitForTimeout(400);
const menuOn = !(await menuHidden());
check(menuOn, '先把菜单打开（点正文中间 toggle 回来）');
const navBox = await page.evaluate(() => {
  const n = document.querySelector('.reader__nav');
  if (!n || getComputedStyle(n).opacity === '0') return null;
  const r = n.getBoundingClientRect();
  return { bottom: Math.round(window.innerHeight - r.bottom) };
});
check(!!navBox, `菜单开着时章末胶囊在场（离底 ${navBox?.bottom}px，和大条同一个位置）`);
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.waitForTimeout(600);
const both = await page.evaluate(() => {
  const wrap = document.querySelector('.reader__progress');
  const nav = document.querySelector('.reader__nav');
  const bar = document.querySelector('.reader__seek');
  if (!wrap || !nav || !bar) return null;
  const a = bar.getBoundingClientRect();
  const b = nav.getBoundingClientRect();
  return {
    open: wrap.classList.contains('is-open'),
    navShown: getComputedStyle(nav).opacity !== '0',
    overlap: !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom),
  };
});
await page.screenshot({ path: join(SHOTS, '2b-from-menu.png'), clip: { x: 0, y: 640, width: 390, height: 204 } });
await page.mouse.up();
check(both?.open === true, '菜单开着也能直接点底部展开大条');
check(both && !both.navShown, '章末胶囊跟着菜单一起收掉了 —— 不会两个悬浮件叠在同一个位置');
check(both && !both.overlap, `两者矩形不相交（overlap=${both?.overlap}）`);

console.log('\n=== 3. 拖动实时跳页 ===');
/* 每一步自己按下、自己抬手：上一版把按下留在第 2 步里，插一步就把后面全废了 */
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.waitForTimeout(600);
const t0 = await scrollTop();
await page.mouse.move(330, cy, { steps: 8 });
await page.waitForTimeout(150);
const tMid = await scrollTop();
check(tMid > t0 + 200, `还按着没松手，滚动位置已经从 ${t0} 走到 ${tMid}（实时跳，不是松手才跳）`);
const during = await seekBox();
check(during?.open === true, '拖动过程中不许自动收起');
await page.mouse.move(80, cy, { steps: 8 });
await page.waitForTimeout(150);
const tBack = await scrollTop();
check(tBack < tMid - 200, `往回拖也跟上：${tMid} → ${tBack}`);
await page.screenshot({ path: join(SHOTS, '3-drag.png'), clip: { x: 0, y: 640, width: 390, height: 204 } });
await page.mouse.up();

console.log('\n=== 4. 松手一秒后自己收回去 ===');
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.waitForTimeout(1400);
check((await seekBox())?.open === true, '按住不放 1.4 秒也不收 —— "没操作"不包括还按着');
await page.mouse.up();
await page.waitForTimeout(500);
check((await seekBox())?.open === true, '刚抬手 0.5 秒还在（不够"没操作"的 1 秒）');
await page.waitForTimeout(900);
const collapsed = await seekBox();
check(collapsed && !collapsed.open, '停手满 1 秒后自动收回');
check(collapsed && collapsed.barH <= 3.5 && !collapsed.thumbVisible, `收回后回到 ${collapsed?.barH}px 的线，滑块消失`);
await page.screenshot({ path: join(SHOTS, '4-collapsed.png'), clip: { x: 0, y: 640, width: 390, height: 204 } });

console.log('\n=== 5. 拖到最右端松手 = 下一章（老规则别弄丢）===');
const beforeTitle = await page.evaluate(() => document.querySelector('.reader__title')?.textContent ?? '');
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(388, cy, { steps: 6 });
await page.waitForTimeout(150);
await page.mouse.up();
await page.waitForTimeout(4000);
const afterTitle = await page.evaluate(() => document.querySelector('.reader__title')?.textContent ?? '');
check(beforeTitle !== afterTitle, `章号变了：「${beforeTitle}」→「${afterTitle}」`);

console.log('\n=== 6. 顶栏没被误伤（类名撞过一次）===');
const barH = await page.evaluate(() => Math.round(document.querySelector('.reader__bar')?.getBoundingClientRect().height ?? -1));
check(barH > 30 && barH < 120, `顶栏还是顶栏的高度 ${barH}px，没被进度条的 3px 规则改掉`);

console.log(errors.length ? `\n  页面报错 ${errors.length} 条：\n    ${errors.slice(0, 6).join('\n    ')}` : '\n  页面零报错');
if (errors.length) fails++;
console.log(`\n截图在 ${SHOTS}`);

await browser.close();
srv.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1200));
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 留着比崩了强 */
}
console.log(fails ? `\n${fails} 条没过` : '\n全部通过');
process.exit(fails ? 1 : 0);
