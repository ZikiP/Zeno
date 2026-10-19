/**
 * 本地量「画面增强换图那一下」：还有没有硬切、以及代价（空白）多长
 *
 * 配套源见 fake-enhance-source.mjs（127.0.0.1:8911，959 宽的合成页图）。
 * 用本地源的理由写在那个文件头上：外网一慢就分不清"下载"和"重采样"各占多少。
 *
 * 两个判据，分开数：
 *   1. **硬切**：src 从原图换成增强版的那一刻，这张是不是已经画出来了
 *      （opacity=1）。是 —— 就是用户报的那一下闪。改完之后这里必须是 0。
 *   2. **空白**：一个可见槽位里"有像素但 opacity=0"的连续时长。这是门控的代价，
 *      只能出现在第一次打开某一页的那几百毫秒里。
 *
 * 跑法：node scripts/verify-enhance-local.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const FAKE = 8911;
const PORT = 8912;
/** ZENO_BASE 指到别的实例（比如 5178 的开发服务），ZENO_REAL 就不自起后端和合成源 */
const BASE = process.env.ZENO_BASE || `http://127.0.0.1:${PORT}`;
const REAL = !!process.env.ZENO_REAL;
const PLUGIN = 'fakesrc';
/** 一屏两张时翻页要用它；ZENO_PAGES=40 可以模拟长章 */
const PAGES = Number(process.env.ZENO_PAGES || 6);

/** 手机视口：390 CSS × DPR3 = 1170 目标宽 > 源图 959 ⇒ 一定走增强 */
const plugin = {
  format: 'zeno-plugin@1',
  meta: { id: PLUGIN, name: '本地合成源', description: '量增强换图时机用，非内容源', author: 'local', version: '1.0.0', icon: '🧪' },
  entry: `http://127.0.0.1:${FAKE}`,
  urls: { search: '/detail?slug={q}', classify: '/detail', detail: '/detail?slug={slug}', chapter: '/chapter?c={id}' },
  parse: {
    card: '<div class="book" title=',
    slugFrom: 'data-slug="([a-z0-9]+)"',
    title: { attr: 'title' },
    cover: 'http://127\\.0\\.0\\.1:8911/img/0\\.png',
    chapterItem: 'class="chap"',
    chapterIdFrom: 'c=(\\d+)',
    imageAttr: 'src',
  },
  imageHosts: ['127.0.0.1'],
  fetch: { mode: { list: 'fetch', detail: 'fetch', chapter: 'fetch' }, timeoutMs: 15000 },
  headers: {},
};

const found = findBrowser();
if (!found) {
  console.error('找不到可用的浏览器');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'zeno-fake-'));
const kill = [];
const run = (cmd, args, env) => {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ...env } });
  kill.push(p);
  return p;
};
if (!REAL) run(process.execPath, ['scripts/fake-enhance-source.mjs'], { FAKE_PORT: String(FAKE), FAKE_PAGES: String(PAGES) });
if (!REAL) run(process.execPath, ['server/index.mjs'], {
  PORT: String(PORT),
  DB_PATH: join(tmp, 'f.db'),
  DIST_DIR: join(ROOT, 'dist'),
  ALLOWED_HOSTS: '127.0.0.1',
  ALLOW_PRIVATE_HOSTS: '1',
  SYNC_TOKEN: '',
  ZENO_UPDATE_CHECK_MS: '0',
});
await new Promise((r) => setTimeout(r, 2500));

if (!REAL) await fetch(`${BASE}/api/sync/push`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deviceId: 'fake',
    seq: 0,
    plugins: [{ id: PLUGIN, origin: 'imported', data: JSON.stringify(plugin), updatedAt: Date.now() }],
  }),
});
const REAL_SLUG = process.env.ZENO_SLUG || 'banbendays';
const REAL_CH = process.env.ZENO_CHAPTER || '4d7c0e04-aac6-11ed-9fa5-024352452ce0';
const REAL_PLUGIN = process.env.ZENO_PLUGIN || 'copymanga';

const INIT = `(() => {
  try { localStorage.setItem('readerEnhance','1'); } catch(e){}
  const T = { ev: [], tl: [], pop: 0, blankMs: 0, frames: 0, blankStart: 0, workers: [], posted: 0, readyAt: 0, wiped: 'no' };
  if (new URLSearchParams(location.search).get('wipe') === '1') {
    T.wiped = 'requested';
    caches.delete('zeno-enhanced').then(() => { T.wiped = 'done'; }, () => { T.wiped = 'fail'; });
  }
  const RealWorker = window.Worker;
  window.Worker = function (...a) { const w = new RealWorker(...a); T.workers.push(Math.round(performance.now())); return w; };
  window.Worker.prototype = RealWorker.prototype;
  const realPost = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (...a) { T.posted++; return realPost.apply(this, a); };
  const save = () => { try { sessionStorage.setItem('__f', JSON.stringify(T)); } catch(e){} };
  window.__T = T;
  window.__reset = (l) => { T.ev = [{ t: Math.round(performance.now()), ev: 'MARK', now: l }]; T.tl = []; T.pop = 0; T.blankMs = 0; T.frames = 0; T.blankStart = 0; save(); };
  window.addEventListener('error', (e) => { (T.errs = T.errs || []).push(String(e.message).slice(0, 120)); });
  window.addEventListener('unhandledrejection', (e) => { (T.errs = T.errs || []).push('reject:' + String(e.reason).slice(0, 120)); });
  window.__mark = (l) => { T.ev.push({ t: Math.round(performance.now()), ev: 'MARK', now: l }); save(); };
  const isBlob = (s) => (s||'').startsWith('blob:');
  /**
   * 「这张确实画在屏幕上了」：不透明度满值并**稳定待过至少两帧**。
   * 首屏那张有 150ms 的淡入，淡入途中换图不该算硬切 —— 算上就永远清不了零。
   */
  const vis = new WeakMap();
  const painted = (el) => vis.get(el) === 'on';
  /**
   * 换图那一刻元素上挂的是不是**已解码的原图**（nat>0 且不是 blob）。
   * 是 —— 那用户就在这一帧之前看过它，这次替换就是硬切。这比"稳定两帧 op=1"
   * 难骗：空白期根本不会点亮那个口径，会把真硬切数成 0。
   */
  const onOriginal = (el) => !isBlob(el.getAttribute('src') || '') && el.naturalWidth > 0;
  document.addEventListener('DOMContentLoaded', () => {
    const seen = new WeakMap();
    new MutationObserver((ms) => {
      for (const m of ms) {
        const el = m.target;
        if (!(el instanceof HTMLImageElement)) continue;
        const s = el.getAttribute('src') || '';
        const prev = seen.get(el) || '';
        if (prev === s || s.startsWith('data:')) continue;
        const was = isBlob(prev);
        seen.set(el, s);
        const swap = !was && isBlob(s);
        if (swap && (painted(el) || onOriginal(el))) {
          T.pop++;   // 原图已经解码在元素上却被换掉 = 硬切，就是要数的那个 0
          T.ev.push({ t: Math.round(performance.now()), ev: 'POP', i: [...document.images].indexOf(el), shown: Math.round(el.offsetWidth), nat: el.naturalWidth, op: getComputedStyle(el).opacity, why: painted(el) ? 'stable-on' : 'decoded-original' });
        }
        T.ev.push({
          t: Math.round(performance.now()),
          ev: swap ? 'UPGRADE' : isBlob(prev) && !isBlob(s) ? 'REVERT' : 'ORIG',
          i: [...document.images].indexOf(el),
          painted: painted(el),
          op: getComputedStyle(el).opacity,
          load: el.getAttribute('loading'),
          shown: Math.round(el.offsetWidth),
          nat: el.naturalWidth,
        });
        save();
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['src'], subtree: true, childList: true });
    const tick = () => {
      // 可见槽位里"有像素但被按住不画"的时长 —— 门控的代价
      for (const im of document.images) {
        if (im.naturalWidth > 0 && im.offsetWidth > 20 && getComputedStyle(im).opacity === '1') {
          if (vis.get(im) === 'warm') vis.set(im, 'on');
          else if (!vis.get(im)) vis.set(im, 'warm');
        } else if (vis.get(im)) vis.set(im, '');
      }
      const img = [...document.images].find((im) =>
        im.naturalWidth > 0 && im.offsetWidth > 20 && im.closest('.reader__spread, .reader__item') &&
        getComputedStyle(im.closest('.reader__spread') || im).visibility !== 'hidden');
      if (img) {
        T.frames++;
        const op = getComputedStyle(img).opacity;
        if ((T.tl = T.tl || []).length < 60) {
          T.tl.push([Math.round(performance.now()), op, img.src.startsWith('blob:') ? 'B' : 'O']);
          save();
        }
        if (op === '0' && img.getAttribute('src')) T.blankFrames = (T.blankFrames || 0) + 1;
        if (op === '0') {
          if (!T.blankStart) T.blankStart = performance.now();
        } else if (T.blankStart) {
          T.blankMs += performance.now() - T.blankStart;
          T.blankStart = 0;
        }
      }
      if (T.frames < 60 * 40) requestAnimationFrame(tick); else save();
    };
    requestAnimationFrame(tick);
  });
})();`;

const browser = await chromium.launch({ headless: true, executablePath: found.exe });
let ctx = await browser.newContext({
  viewport: { width: Number(process.env.ZENO_W || 390), height: Number(process.env.ZENO_H || 844) },
  deviceScaleFactor: Number(process.env.ZENO_DPR || 3),
  locale: 'zh-CN',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});
await ctx.addInitScript(INIT);
let page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 140)}`));

const readTrace = () =>
  page.evaluate(() => {
    try {
      return JSON.parse(sessionStorage.getItem('__f') || 'null') || window.__T || null;
    } catch {
      return null;
    }
  });

const dump = async (why) => {
  const s = await page
    .evaluate(() => ({
      href: location.pathname,
      text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160),
      imgs: [...document.images]
        .map((i) => `${i.src.startsWith('blob:') ? 'B' : 'O'}${i.naturalWidth}/${getComputedStyle(i).opacity}`)
        .slice(0, 4),
    }))
    .catch((e) => ({ err: String(e).slice(0, 100) }));
  console.log(`[dump:${why}] ${JSON.stringify(s)}`);
};

let markAt = 0;

/** 等 mark 之后攒够 want 次换图，然后报：硬切几次、空白多久 */
async function report(label, want, ms = 30_000) {
  const t0 = Date.now();
  let tr = null;
  while (Date.now() - t0 < ms) {
    tr = await readTrace();
    if ((tr?.ev ?? []).filter((e) => e.t >= markAt && e.ev === 'UPGRADE').length >= want) break;
    await page.waitForTimeout(400);
  }
  const evs = (tr?.ev ?? []).filter((e) => e.t >= markAt);
  const ups = evs.filter((e) => e.ev === 'UPGRADE');
  const firstOrig = evs.find((e) => e.ev === 'ORIG');
  const rel = (x) => (x === undefined ? '-' : Math.round(x - markAt));
  console.log(
    `\n=== ${label} ===\n` +
      `  换图 ${ups.length}/${want} 次（首张 ${rel(ups[0]?.t)}ms，末张 ${rel(ups[ups.length - 1]?.t)}ms）` +
      `，第一张原图进 DOM ${rel(firstOrig?.t)}ms\n` +
      `  **硬切（原图已画出后被换）${tr?.pop ?? '?'} 次**，门控空白合计 ${Math.round(tr?.blankMs ?? 0)}ms / ${tr?.frames ?? 0} 帧
` +
      `  硬切明细（哪几张在已画原图后被换）：${JSON.stringify(evs.filter((e) => e.ev === 'POP'))}
` +
      `  事件明细：${JSON.stringify(evs.slice(0, 8))}
` +
      `  可见槽逐帧(时间/opacity/哪张图)：${JSON.stringify(tr?.tl ?? [])}`,
  );
  await dump(label);
  return tr;
}

async function pickFromDrawer(offset) {
  await page.evaluate(() => document.querySelector('button[aria-label="章节目录"]')?.click());
  for (let i = 0; i < 25; i++) {
    if ((await page.evaluate(() => document.querySelectorAll('.drawer__item').length)) > 0) break;
    await page.waitForTimeout(400);
  }
  const got = await page.evaluate((o) => {
    const items = [...document.querySelectorAll('.drawer__item')];
    const cur = items.findIndex((el) => el.classList.contains('on'));
    const target = items[cur + o];
    const name = target?.querySelector('.drawer__item-name')?.textContent;
    target?.click();
    return { cur, total: items.length, name };
  }, offset);
  await page.waitForTimeout(600);
  return got;
}

/** 全新 profile 要先有插件；还得从详情页进一次，章节表才有缓存（抽屉点章靠它） */
await page.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
if (REAL) {
  /* 真源真机档：直接开一章，量「第一张增强图多久落地、有没有硬切、空白多久」 */
  const vw = Number(process.env.ZENO_W || 390);
  await page.evaluate((wipe) => {
    try { sessionStorage.clear(); if (wipe) caches.delete('zeno-enhanced'); } catch (e) {}
    window.__reset('realCold');
  }, !!process.env.ZENO_WIPE_DISK);
  const at = await page.evaluate(() => performance.now());
  await page.goto(`${BASE}/read/${REAL_PLUGIN}/${REAL_SLUG}/${REAL_CH}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('.reader__cell img, .reader__page', { timeout: 120_000, state: 'attached' }).catch(() => dump('real-attach'));
  let tr = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    tr = await readTrace();
    if ((tr?.ev || []).some((e) => e.ev === 'UPGRADE')) break;
    await page.waitForTimeout(500);
  }
  const st = await page.evaluate(() => {
    const img = document.querySelector('.reader__cell img') || document.querySelector('.reader__page');
    return img ? { blob: img.src.startsWith('blob:'), shown: Math.round(img.offsetWidth), nat: img.naturalWidth, op: getComputedStyle(img).opacity, dpr: window.devicePixelRatio, targetW: Math.round(img.offsetWidth * window.devicePixelRatio) } : null;
  });
  const evs = tr?.ev || [];
  const up = evs.find((e) => e.ev === 'UPGRADE');
  console.log(
    `
=== 真源 ${REAL_PLUGIN}/${REAL_SLUG} @ ${vw}x${Number(process.env.ZENO_H || 844)} dpr${Number(process.env.ZENO_DPR || 3)} ===
` +
      `  页图：显示宽 ${st?.shown} × dpr = 目标宽，源图 ${st?.nat} 宽
` +
      `  首张增强落地：${up ? `${Math.round(up.t - at)}ms（事件 ${JSON.stringify(up)}）` : '没等到 —— 说明这一档不触发或被跳过'}
` +
      `  硬切 ${tr?.pop ?? 0} 次，空白 ${Math.round(tr?.blankMs ?? 0)}ms，逐帧 ${evs.slice(0, 3).map((e) => `${e.t}:${e.ev}:${e.nat}`).join(' / ')}
` +
      `  现在第一张：${JSON.stringify(st)}；Worker ${(tr?.workers || []).length} 台 / 发活 ${tr?.posted ?? 0}`,
  );
  console.log(`  前 8 条事件：${JSON.stringify(evs.slice(0, 8))}`);
  if (process.env.ZENO_WATCH) {
    let prev = -1;
    for (let i = 0; i < Number(process.env.ZENO_WATCH); i++) {
      const w = await page.evaluate(() => {
        const all = [...document.querySelectorAll('.reader__page')];
        return {
          blob: all.filter((x) => x.src.startsWith('blob:')).length,
          gated: all.filter((x) => getComputedStyle(x).opacity === '0' && x.naturalWidth > 0).length,
          posted: window.__T?.posted ?? 0,
          workers: (window.__T?.workers || []).length,
          errs: (window.__T?.errs || []).slice(-3),
        };
      });
      if (w.blob !== prev) { console.log(`  +${i * 3}s blob=${w.blob} gated空白=${w.gated} 发活=${w.posted} Worker=${w.workers}`); prev = w.blob; }
      await page.waitForTimeout(3000);
    }
  }
  await page.screenshot({ path: join(ROOT, 'dist/enhance-wide.png'), clip: { x: 0, y: 0, width: Math.min(vw, 1400), height: 700 } });
  console.log(`  截图 dist/enhance-wide.png`);
  await browser.close();
  for (const p of kill) p.kill();
  try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log(`(临时目录没删：${tmp})`); }
  process.exit(0);
}
await page.waitForTimeout(1200);
await page.evaluate(
  (item) =>
    new Promise((res, rej) => {
      const o = indexedDB.open('zeno-reader');
      o.onerror = () => rej(o.error);
      o.onsuccess = () => {
        const d = o.result;
        if (!d.objectStoreNames.contains('plugins')) return rej(new Error('没有 plugins 表'));
        const tx = d.transaction('plugins', 'readwrite');
        tx.objectStore('plugins').put(item);
        tx.oncomplete = () => res(1);
        tx.onerror = () => rej(tx.error);
      };
    }),
  { id: PLUGIN, plugin, installedAt: Date.now(), updatedAt: Date.now(), origin: 'imported' },
);

if (!process.env.ZENO_ONLY_LONG) {
if (process.env.ZENO_FRESH) {
  /* 全新 context：Cache Storage 按 origin 存，换一个 context 就是真·第一次 */
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, locale: 'zh-CN' });
  await ctx.addInitScript(INIT);
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.evaluate(
    (item) => new Promise((res, rej) => {
      const o = indexedDB.open('zeno-reader');
      o.onsuccess = () => {
        const d = o.result;
        if (!d.objectStoreNames.contains('plugins')) return rej(new Error('没有 plugins 表'));
        const tx = d.transaction('plugins', 'readwrite');
        tx.objectStore('plugins').put(item);
        tx.oncomplete = () => res(1);
        tx.onerror = () => rej(tx.error);
      };
      o.onerror = () => rej(o.error);
    }),
    { id: PLUGIN, plugin, installedAt: Date.now(), updatedAt: Date.now(), origin: 'imported' },
  );
  console.log('  （换了全新 context：盘上这一层也是空的）');
}

if (process.env.ZENO_WIPE_DISK) {
  const p0 = await ctx.newPage();
  await p0.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded' });
  await p0.evaluate(async () => { await caches.delete('zeno-enhanced'); });
  await p0.close();
  console.log('  （已清空 zeno-enhanced 桶：这一趟是真·第一次）');
}

/* ── 分页模式（用户实际在用的一档） ── */
await page.goto(`${BASE}/comic/${PLUGIN}/demo`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
for (let i = 0; i < 25; i++) {
  if ((await page.evaluate(() => document.querySelectorAll('a[href^="/read/"]').length)) > 0) break;
  await page.waitForTimeout(400);
}
await page.evaluate(() => document.querySelector('a[href^="/read/"]')?.click());
await page.waitForSelector('.reader__cell img', { timeout: 60_000, state: 'attached' }).catch(() => dump('enter'));
await page.evaluate(() => document.querySelector('button[aria-label="切换模式"]')?.click());
await page.waitForTimeout(1500);
const modeNow = await page.evaluate(() => localStorage.getItem('readerMode'));
console.log(`\n  当前档位：${JSON.stringify(modeNow)}`);

await page.evaluate(() => {
  try {
    sessionStorage.clear();
  } catch (e) {}
  window.__reset('cold');
  return performance.now();
});
markAt = await page.evaluate(() => performance.now());
await page.goto(`${BASE}/read/${PLUGIN}/demo/2?wipe=${process.env.ZENO_WIPE_AT_BOOT ? '1' : '0'}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.reader__cell img', { timeout: 60_000, state: 'attached' }).catch(() => dump('cold'));
markAt = 0;
await report('① 分页：冷启动打开一章（缓存空，代价=空白）', 2, 25_000);

await page.evaluate(() => {
  window.__reset('turn');
  window.__markAt = performance.now();
});
markAt = await page.evaluate(() => window.__markAt);
await page.evaluate(() => document.querySelector('.paged-tap--r')?.click());
await page.waitForTimeout(1200);
await page.evaluate(() => document.querySelector('.paged-tap--r')?.click());
await report('② 分页：章内翻两屏（下一屏在隐藏槽里就该已备好）', 2, 20_000);

/* 读一会儿，让"下一章预热"跑到 */
await page.waitForTimeout(3500);
await page.evaluate(() => {
  window.__reset('nextCh');
  window.__markAt = performance.now();
});
markAt = await page.evaluate(() => window.__markAt);
const picked = await pickFromDrawer(1);
console.log(`  抽屉点了：${JSON.stringify(picked)}`);
await page.waitForTimeout(2500);
await report('③ 分页：进下一章（预热应已把增强版算好 ⇒ 落地就是增强图）', 2, 25_000);

/* ④ 同一章再打开一次：增强版是进程级缓存，第二次应该一张都不换（连空白都没有） */
await page.evaluate(() => {
  window.__reset('again');
  window.__markAt = performance.now();
});
markAt = await page.evaluate(() => window.__markAt);
await pickFromDrawer(-1);
await page.waitForTimeout(2000);
await report('④ 再回到刚才那章（缓存全命中）', 0, 6_000);

/* ⑤ 滚动模式：整章一起挂载，代价形态不一样 */
await page.evaluate(() => document.querySelector('button[aria-label="切换模式"]')?.click());
await page.waitForTimeout(1200);
await page.evaluate(() => {
  try {
    sessionStorage.clear();
  } catch (e) {}
  window.__reset('scrollCold');
});
markAt = 0;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.reader__page', { timeout: 60_000, state: 'attached' }).catch(() => dump('scroll'));
await page.waitForTimeout(4000);
await report('⑤ 滚动模式冷开一章', 3, 25_000);
/* 滚一段再看：正常逐段下滑时，进视野前那几百毫秒的空档够不够算完增强 */
markAt = await page.evaluate(() => {
  window.__reset('afterScroll');
  return performance.now();
});
await page.evaluate(async () => {
  const el = document.querySelector('.reader__scroll');
  const step = Math.round(el.clientHeight * 0.8);
  for (let i = 0; i < 8; i++) {
    el.scrollBy(0, step);
    await new Promise((r) => setTimeout(r, 420));
  }
});
await page.waitForTimeout(5000);
await report('⑥ 滚动模式逐段下滑', 1, 20_000);

/*
 * ⑦ 长章 + 章级预取：切到滚动，冷开一章（ZENO_PAGES 张），1 秒后**一下跳到章末**。
 * 这是最狠的一种：用户跳过去的那一刻，中间几十页一张都没看过。
 * 有预取时该看到的是"预取已经排到章尾、算到哪儿了"，而不是一片黑。
 */
} /* !ZENO_ONLY_LONG */

if (PAGES > 12) {
  await page.evaluate(() => {
    if (localStorage.getItem('readerMode') !== 'scroll') {
      document.querySelector('button[aria-label="切换模式"]')?.click();
    }
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    try {
      sessionStorage.clear();
    } catch (e) {}
    window.__reset('longScroll');
  });
  markAt = 0;
  await page.goto(`${BASE}/read/${PLUGIN}/demo/1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.reader__page', { timeout: 60_000, state: 'attached' }).catch(() => dump('long'));
  await page.waitForTimeout(1000);
  const drainRate = await page.evaluate(() => {
    const el = document.querySelector('.reader__scroll');
    const t0 = performance.now();
    el.scrollTo(0, el.scrollHeight);
    return { at: Math.round(t0), height: el.scrollHeight };
  });
  console.log(`\n  章高 ${drainRate.height}px，在 ${drainRate.at}ms 时一下跳到章末`);
  await page.waitForTimeout(2000);
  await report('⑦ 长章滚动：冷开 1 秒后直接跳章末', 1, 15_000);
  const state = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.reader__page')];
    return {
      imgs: all.length,
      blob: all.filter((i) => i.src.startsWith('blob:')).length,
      blank: all.filter((i) => getComputedStyle(i).opacity === '0' && i.naturalWidth > 0).length,
    };
  });
  const qh = await page.evaluate(() => ({ evs: (window.__T?.ev || []).filter((e) => e.ev === 'UPGRADE').map((e) => e.t) }));
  console.log(`  此刻整章：在场 ${state.imgs} 张 / 已增强 ${state.blob} 张 / 被按住不画 ${state.blank} 张`);
  console.log(`  已换图的时刻（毫秒，看排空速度）：${JSON.stringify(qh.evs.slice(0, 12))}`);
  console.log(`  Worker：${JSON.stringify((await readTrace())?.workers || [])} 台，发了 ${JSON.stringify((await readTrace())?.posted || 0)} 张活`);
  /* 再等 20 秒，看队列把整章排空要多久（一页 500ms 量级） */
  await page.waitForTimeout(20_000);
  const later = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.reader__page')];
    return { blob: all.filter((i) => i.src.startsWith('blob:')).length, blank: all.filter((i) => getComputedStyle(i).opacity === '0' && i.naturalWidth > 0).length };
  });
  console.log(`  再等 20 秒：已增强 ${later.blob} 张 / 还空着 ${later.blank} 张`);
}

/*
 * ⑨⑩ 盘上那一份 + 两台 Worker：
 *   第一次冷开整章要算完（记 worker 台数、排空耗时、空白时长），reload 之后同一章
 *   应当几乎立刻全就绪 —— 这是"重读不重算"唯一能被量出来的形态。
 */
if (PAGES > 12 && process.env.ZENO_DISK) {
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, locale: 'zh-CN' });
  await ctx3.addInitScript(INIT);
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => errors.push(`pageerror(disk): ${e.message}`));
  await p3.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded' });
  await p3.waitForTimeout(800);
  await p3.evaluate(
    (item) => new Promise((res, rej) => {
      const o = indexedDB.open('zeno-reader');
      o.onsuccess = () => {
        const d = o.result;
        if (!d.objectStoreNames.contains('plugins')) return rej(new Error('没有 plugins 表'));
        const tx = d.transaction('plugins', 'readwrite');
        tx.objectStore('plugins').put(item);
        tx.oncomplete = () => res(1);
        tx.onerror = () => rej(tx.error);
      };
      o.onerror = () => rej(o.error);
    }),
    { id: PLUGIN, plugin, installedAt: Date.now(), updatedAt: Date.now(), origin: 'imported' },
  );
  page = p3;
  const runCold = async (label) => {
    await page.goto(`${BASE}/read/${PLUGIN}/demo/1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.reader__page', { timeout: 60_000, state: 'attached' });
    await page.evaluate((l) => window.__reset(l), label);
    const t0 = Date.now();
    let st = null;
    while (Date.now() - t0 < 90_000) {
      st = await page.evaluate(() => {
        const all = [...document.querySelectorAll('.reader__page')];
        const vh = window.innerHeight;
        const inView = all.filter((i) => i.getBoundingClientRect().top < vh * 3);
        return {
          imgs: all.length,
          inView: inView.length,
          ready: inView.filter((i) => i.src.startsWith('blob:')).length,
          blob: all.filter((i) => i.src.startsWith('blob:')).length,
          workers: (window.__T?.workers || []).length,
          posted: window.__T?.posted || 0,
          blankMs: Math.round(window.__T?.blankMs || 0),
          pop: window.__T?.pop || 0,
          probe: (window.__enhProbe || null),
        };
      });
      if (st.ready >= st.inView && st.inView > 0) break;
      await page.waitForTimeout(1000);
    }
    console.log(
      `\n=== ${label} ===\n` +
        `  在场 ${st.imgs} 张 / 全就绪 ${st.blob} 张，用了 ${Math.round(Date.now() - t0)}ms` +
        `；建了 ${st.workers} 台 Worker、发了 ${st.posted} 张活\n` +
        `  可见页空白 ${st.blankMs}ms，硬切 ${st.pop} 次；盘上探针 ${JSON.stringify(st.probe)}`,
    );
    return st;
  };
  const first = await runCold('⑨ 第一次冷开整章（真算）');
  /* 等这一章真的全算完再往下量：⑩ 要的是"整章都已在盘上"的第二次阅读 */
  await page.waitForTimeout(30_000);
  const keys1 = await page.evaluate(async () => (await (await caches.open('zeno-enhanced')).keys()).length);
  console.log(`  ⑨ 结束时桶里有 ${keys1} 条`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const second = await runCold('⑩ reload 后同一章（盘上该有）');
  const keys2 = await page.evaluate(async () => (await (await caches.open('zeno-enhanced')).keys()).length);
  console.log(`  ⑩ 结束时桶里有 ${keys2} 条`);
  console.log(`  ⇒ 第二次少花 ${Math.max(0, Math.round((1 - second.blankMs / Math.max(1, first.blankMs)) * 100))}% 的空白时长（重读不重算）`);
  /* 逐段滚到底：每一站看一眼脚下那张是不是已经是增强图 */
  let notReady = 0;
  let seen = 0;
  for (let i = 0; i < 10; i++) {
    const st = await page.evaluate(() => {
      const el = document.querySelector('.reader__scroll');
      el.scrollBy(0, el.clientHeight);
      return new Promise((r) => setTimeout(() => {
        const img = [...document.querySelectorAll('.reader__page')].find((i) => {
          const b = i.getBoundingClientRect();
          return b.bottom > 0 && b.top < window.innerHeight && i.offsetWidth > 20;
        });
        r(img ? { blob: img.src.startsWith('blob:'), blank: getComputedStyle(img).opacity === '0' } : null);
      }, 350));
    });
    if (!st) continue;
    seen++;
    if (!st.blob) notReady++;
    if (i === 9) break;
  }
  console.log(`  ⑩ 之后逐段滚 ${seen} 屏：脚下不是增强图的是 ${notReady} 屏（盘上命中时应当是 0）`);
}

if (errors.length) console.log('\n页面报错：\n  ' + [...new Set(errors)].slice(0, 6).join('\n  '));

await browser.close();
for (const p of kill) p.kill();
await new Promise((r) => setTimeout(r, 1500));
try {
  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.log(`(临时目录没删掉：${tmp} —— ${String(e).slice(0, 60)})`);
}
process.exit(0);
