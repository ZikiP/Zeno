/**
 * 量画面增强的吞吐：Worker 台数 vs 整章铺完要多久（dist 需先 npm run build）
 *
 * 台数由 enhance.ts 的 DEFAULT_POOL 定，这里用 ?pool=N 临时改档（写进 localStorage，
 * 应用在起 Worker 之前读它）。跑法：node scripts/verify-enhance-throughput.mjs
 * 可调：ZENO_POOLS=2,4,6,8 ZENO_CHAPTERS=…（换没铺过的章，否则第二趟全是缓存命中）
 */
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const BASE = process.env.ZENO_BASE || 'http://127.0.0.1:8788';
const SLUG = 'wodetudidushidafanpai-yuetian';
const CHS = (process.env.ZENO_CHAPTERS || '0_382,0_383,0_384,0_385,0_386,0_387').split(',');
const POOLS = (process.env.ZENO_POOLS || '2,4,6,8').split(',').map(Number);
const found = findBrowser();

const INIT = `(() => {
  try {
    localStorage.setItem('readerEnhance', '1');
    localStorage.setItem('readerMode', 'paged');
    const q = new URLSearchParams(location.search).get('pool');
    if (q) localStorage.setItem('enhancePool', q);
  } catch (e) {}
  const T = { results: 0, posted: 0, t0: performance.now(), first: 0, blank: 0 };
  const rc = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { if (b && b.type === 'image/png') { T.results++; if (!T.first) T.first = Math.round(performance.now() - T.t0); } return rc(b); };
  const RW = window.Worker;
  window.Worker = function (...a) { return new RW(...a); };
  window.Worker.prototype = RW.prototype;
  const rp = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (...a) { T.posted++; return rp.apply(this, a); };
  /** 屏上被门控按住的每一帧都记下来：这就是"用户在黑屏里站了多久" */
  const frame = () => {
    const imgs = [...document.images].filter((i) => { const r = i.getBoundingClientRect(); return r.width > 20 && r.top < innerHeight && r.bottom > 0 && getComputedStyle(i.closest('.reader__spread') || i).visibility !== 'hidden'; });
    if (imgs.length && imgs.every((i) => !(getComputedStyle(i).opacity === '1' && i.naturalWidth > 0))) T.blank++;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.__T = T;
  window.__snap = () => ({ ...T, blankSec: +(T.blank / 60).toFixed(1) });
})();`;

const b = await chromium.launch({ headless: true, executablePath: found.exe });
console.log(`每档换一个全新的 profile + 一章没碰过的内容（共 ${CHS.length} 章轮换）\n`);
for (const pool of POOLS) {
  const ch = CHS[pool % CHS.length];
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(INIT);
  const p = await ctx.newPage();
  const t0 = Date.now();
  await p.goto(`${BASE}/read/baozimh/${SLUG}/${ch}?pool=${pool}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await p.waitForSelector('.reader__cell img', { timeout: 120_000 }).catch(() => {});
  let last = -1;
  let stuck = 0;
  let doneAt = 0;
  const marks = [];
  while (Date.now() - t0 < 90_000) {
    const s = await p.evaluate(() => window.__snap());
    if (s.results !== last) { marks.push(`${Math.round((Date.now() - t0) / 1000)}s:${s.results}`); last = s.results; stuck = 0; doneAt = Date.now() - t0; }
    else if (++stuck > 7) break;
    await p.waitForTimeout(1000);
  }
  const s = await p.evaluate(() => window.__snap());
  const el = s.results ? doneAt / 1000 : 0;
  console.log(
    `POOL=${pool}：${s.results} 张算完用了 ${el.toFixed(1)}s → **${(s.results / el).toFixed(2)} 页/秒**；` +
      `首张 ${s.first}ms；门控黑屏合计 ${s.blankSec}s\n  进度（ms:张数）：${marks.filter((_, i) => i % 4 === 0).join(' ')}`,
  );
  await ctx.close();
}
await b.close();
