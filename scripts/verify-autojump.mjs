/**
 * 上拉接下一章 —— 进来之后画面自己往下跑了吗
 *
 * 用户报的现象：滚动模式里攒满上拉、跳进新章之后，画面自己往上又翻了几页。
 * 根因是新章存过进度，`useRestoreProgress` 把人送回了上次那一页。
 * 这条不是代码路径的断言，是**像素位置**的断言：只量 scrollTop。
 *
 * 为什么要真浏览器：蓄力靠 requestAnimationFrame 攒时间，
 * 藏在后台的标签页里没有帧，事件派发得再多也不会跳章（实测过）。
 *
 * 跑法：node scripts/verify-autojump.mjs
 * 不进 npm test：CI 没有浏览器也没有外网，只会假失败。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 8896;
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN = 'baozimh';
const SLUG = 'woduzishengji-duburedicestudio';
/** 用来做上拉的那两章：a 的下一章是 b */
const A = '0_111';
const B = '0_112';
/** 单独用来验"手动进章仍然恢复"的那一章 */
const C = '0_113';
/** 冷启动那一遍要等服务端自己把门神过掉，第一次给足 */
const RENDER_WAIT = 150_000;

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('先 npm run build（这个走查看的是 dist 里那份）');
  process.exit(2);
}
const found = findBrowser();
if (!found) {
  console.error('本机没有 chromium 系浏览器');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'zeno-autojump-'));

const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: join(tmp, 'aj.db'),
    ALLOWED_HOSTS: '',
    SYNC_TOKEN: '',
    DIST_DIR: join(ROOT, 'dist'),
  },
});
await new Promise((r) => setTimeout(r, 1500));

/*
 * 插件要两头都装：
 *  - 服务端那份决定代理放不放行、带不带插件声明的请求头（见 server/allowlist.mjs）。
 *  - 浏览器 IndexedDB 里那份才是"这个设备装了它"，页面据此解析 /read/…/:pluginId。
 * 临时 profile 是全新的，两头都得自己种。
 */
const plugin = JSON.parse(readFileSync(join(ROOT, 'baozimh-plugin.json'), 'utf8'));
await fetch(`${BASE}/api/sync/push`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deviceId: 'autojump',
    seq: 0,
    plugins: [
      { id: plugin.meta.id, origin: 'imported', data: JSON.stringify(plugin), updatedAt: Date.now() },
    ],
  }),
});

const browser = await chromium.launch({
  headless: true,
  executablePath: found.exe,
  args: ['--proxy-bypass-list=*.ts.net;127.0.0.1;localhost'],
});
/* 手机形状：滚动模式是竖向的，桌面宽度一屏就放下，根本没有"章末"可言 */
const ctx = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  locale: 'zh-CN',
});
const page = await ctx.newPage();
const errors = [];
const net = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 140)}`));
page.on('response', (r) => {
  if (r.url().includes('/api/')) net.push(`${r.status()} ${r.url().slice(BASE.length, BASE.length + 90)}`);
});

/** 挂了就别只丢一个 TimeoutError：把画面上的字和接口流水打出来 */
async function die(where, e) {
  const text = await page
    .evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300))
    .catch(() => '(读不到 body)');
  console.error(`\n${where} 失败：${e?.message?.slice(0, 120)}`);
  console.error(`  页面上写着：${text}`);
  console.error(`  接口流水：\n    ${net.slice(-12).join('\n    ') || '(一个 /api 请求都没有)'}`);
  await browser.close();
  srv.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1200));
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 留着比崩了强 */
  }
  process.exit(2);
}

/* 中途任何一步炸了都要把服务收掉，不然 8896 上多一个孤儿进程 */
process.on('unhandledRejection', (e) => die('流程', e));

/** 滚动容器现在的绝对位置 */
const scrollState = () =>
  page.evaluate(() => {
    const el = document.querySelector('.reader__scroll');
    if (!el) return null;
    return {
      top: Math.round(el.scrollTop),
      client: Math.round(el.clientHeight),
      range: Math.round(el.scrollHeight - el.clientHeight),
    };
  });

/** 书架上这一条记的位置（直接用页面里的 IndexedDB 读，别假设存哪） */
const readPositions = () =>
  page.evaluate(
    (slug) =>
      new Promise((res, rej) => {
        const o = indexedDB.open('zeno-reader');
        o.onerror = () => rej(o.error);
        o.onsuccess = () => {
          const db = o.result;
          const q = db.transaction('shelf', 'readonly').objectStore('shelf').getAll();
          q.onerror = () => rej(q.error);
          q.onsuccess = () => {
            const e = q.result.find((x) => x.slug === slug);
            res(e ? { positions: e.positions, last: e.lastChapterId } : null);
          };
        };
      }),
    SLUG,
  );

const url = (id) => `${BASE}/read/${PLUGIN}/${SLUG}/${id}`;

/**
 * 把插件种进这个全新 profile 的 IndexedDB。
 *
 * 先 goto 一次 /shelf 让应用自己把库开到当前版本 ——
 * 空着库去 open(name) 只会建出一个 version 1 的裸库，表都没有。
 */
async function installPlugin() {
  await page.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
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
    {
      id: plugin.meta.id,
      plugin,
      installedAt: Date.now(),
      updatedAt: Date.now(),
      origin: 'imported',
    },
  );
}

/** 等到这一章能读：容器在、图撑起高度、最后一张落地 */
async function openChapter(id, tries = 6) {
  for (let i = 0; i < tries; i++) {
    await page.goto(url(id), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.reader__scroll');
          return !!el && el.scrollHeight - el.clientHeight > 2000;
        },
        undefined,
        { timeout: RENDER_WAIT, polling: 300 },
      );
      return;
    } catch {
      /* 上游那一轮没成，换个节奏再来一次 */
      await page.waitForTimeout(1500);
    }
  }
  throw new Error(`章节 ${id} 打不开（滚动高度一直没起来）`);
}

/**
 * 拖到"整本的百分比"上，等进度写进 IndexedDB。
 * 写进度是节流过的，所以先滚两下再等，别指望一次到位。
 */
async function parkAt(pct) {
  const target = () =>
    page.evaluate((p) => {
      const el = document.querySelector('.reader__scroll');
      el.scrollTop = (el.scrollHeight - el.clientHeight) * p;
    }, pct);
  await target();
  await page.waitForTimeout(400);
  await target();
  await page.waitForTimeout(2500);
  return target();
}

/** 停在章末 + 一路往上推轮，直到真的接上下一章 */
async function pullToNext() {
  /*
   * 一次 scrollTop = scrollHeight 不够：后面那些图是懒加载的，
   * 边加载边把 scrollHeight 往上顶，人就跟在"假底部"上，
   * 离真底部差着几百 px → 状态机认为还没到章末，提示也就不出来。
   * 所以一边等一边反复贴底。
   */
  let hint = null;
  let lastText = '(章末那一行不在 DOM 里)';
  for (let i = 0; i < 120 && !hint; i++) {
    await page.evaluate(() => {
      const el = document.querySelector('.reader__scroll');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(500);
    hint = await page.evaluate(() => document.querySelector('.reader__end')?.textContent.trim() ?? null);
    if (hint?.includes('上拉接下一章')) break;
    lastText = hint ?? '(没了)';
    hint = null;
  }
  if (!hint) {
    const info = await page.evaluate(() => {
      const el = document.querySelector('.reader__scroll');
      const imgs = [...document.querySelectorAll('.reader__page')];
      return {
        prefs: localStorage.getItem('readerPrefs'),
        top: Math.round(el?.scrollTop ?? -1),
        range: Math.round((el?.scrollHeight ?? 0) - (el?.clientHeight ?? 0)),
        imgTotal: imgs.length,
        imgReady: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      };
    });
    /* 「— 本章完 —」= 没挂上（开关或没认到底）；「正在取最后几张…」= 挂上了但图没落地 */
    throw new Error(`章末提示一直是「${lastText}」：${JSON.stringify(info)}`);
  }
  console.log(`  章末那一行现在写着「${hint}」`);
  await page.mouse.move(195, 400);
  for (let i = 0; i < 40; i++) {
    if (page.url().endsWith(`/${B}`)) return true;
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(120);
  }
  return page.url().endsWith(`/${B}`);
}

console.log(`目标 ${BASE} ｜ ${PLUGIN}/${SLUG} ｜ 390x844 触屏`);

/* ── 1. 环境：装上源、把这本书加入书架、自动下一章开着 ── */
await installPlugin();
await page.evaluate((prefs) => {
  localStorage.setItem('readerPrefs', JSON.stringify({ ...prefs, __at: Date.now() }));
}, { autoNextChapter: true, pullMs: 1500, keepAwake: true, turnAnim: 'flip', immersive: false });

await page.goto(`${BASE}/comic/${PLUGIN}/${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
/* 全新的一份 DB + 全新的浏览器 profile：第一遍要替服务端把门神那一关过掉，慢慢等 */
try {
  await page.waitForFunction(() => /加入书架|已在书架/.test(document.body.innerText), undefined, {
    timeout: 180_000,
    polling: 1000,
  });
} catch (e) {
  await die('详情页', e);
}
const btn = page.locator('button', { hasText: /加入书架|已在书架/ }).first();
if ((await btn.innerText()).includes('加入')) await btn.click();
await page.waitForTimeout(800);
check(!!(await readPositions()), '这本书在书架上（不在的话进度根本不写，测试会假过）');

/* ── 2. 给 B 章存一个"上次读到中段"的位置 ── */
await openChapter(B);
await parkAt(0.45);
const planted = await readPositions();
const plantedPct = planted?.positions?.[B] ?? 0;
console.log(`\n=== 2. 先把 B 章（${B}）摆到中段`);
check(
  plantedPct > 20 && plantedPct < 70,
  `B 章存上了中段位置：${plantedPct}%（不在 20–70 就是没写进去，后面全是假过）`,
);

/* ── 3. 上拉接章：落点必须是新章顶部 ── */
console.log(`\n=== 3. 从 A 章（${A}）上拉接 B 章`);
await openChapter(A);
const jumped = await pullToNext();
check(jumped, `攒满上拉之后跳到了 B 章（当前 ${page.url().split('/').pop()}）`);

/*
 * 关键断言。
 * 原来的 bug 是**异步的**：positions 从 IndexedDB 读上来比进章晚一帧，
 * 立刻量一次是 0，过一会儿才被甩到中段。所以这里跨 2 秒量 6 次，
 * 只要有一次不在顶上就算挂。
 */
const samples = [];
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(400);
  samples.push(await scrollState());
}
const worst = samples.reduce((m, s) => (s && s.top > m.top ? s : m), samples[0]);
console.log(`\n=== 4. 进去之后画面稳不稳（每 400ms 量一次，共 6 次）`);
console.log(`  scrollTop：${samples.map((s) => s?.top).join(' → ')}（本章可滚 ${worst?.range}）`);
check(worst.top === 0, `全程贴在章首，没有被自己往下拽（最大 ${worst.top}）`);
check(
  worst.range > 3000,
  `B 章确实长到"跑几页"看得出来（可滚 ${worst.range}px）—— 一屏放得下的话上面那条断言根本不可能失败`,
);

/* ── 5. 手动进章照旧恢复，别把它一起关了 ── */
console.log(`\n=== 5. 手动那条路还要能回到上次那一页`);
await openChapter(C);
await parkAt(0.5);
const cPct = (await readPositions())?.positions?.[C] ?? 0;
check(cPct > 25 && cPct < 75, `C 章（${C}）存到 ${cPct}%`);
await openChapter(A);
await page.goto(url(C), { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(
  () => {
    const el = document.querySelector('.reader__scroll');
    return !!el && el.scrollHeight - el.clientHeight > 2000;
  },
  undefined,
  { timeout: RENDER_WAIT, polling: 300 },
);
await page.waitForTimeout(2500);
const restored = await scrollState();
const restoredPct = Math.round((restored.top / restored.range) * 100);
console.log(`  手动进 C 章落在 scrollTop ${restored.top}（约 ${restoredPct}%）`);
check(
  restoredPct > 25 && restoredPct < 75,
  `手动进章仍会回到上次那一页（落在 ${restoredPct}%，存的是 ${cPct}%）`,
);

check(errors.length === 0, `控制台没有报错${errors.length ? '：' + errors.slice(0, 3).join(' / ') : ''}`);

await browser.close();
srv.kill('SIGTERM');
/* Windows 上 SIGTERM 就是 TerminateProcess，sqlite 那个句柄要过一小会儿才散 */
await new Promise((r) => setTimeout(r, 1200));
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  console.log(`  临时目录没删掉，手动清一下：${tmp}`);
}

console.log(fails === 0 ? '\n上拉接章落在章首，手动那条没被带坏' : `\n${fails} 条没过`);
process.exit(fails ? 1 : 0);
