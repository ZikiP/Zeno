/**
 * 画面增强（实验）端到端验证
 *
 * 这一档的失败模式分两类，都得在真浏览器里量，纯函数测试管不到：
 *   1. **该出手时不出手**：门控在 Worker 里判（源图宽度 ≥ 显示宽度就跳过），
 *      判反了会变成"桌面也在白算"或"手机上一张都不增强"，界面上一模一样。
 *   2. **换图那一下闪**：src 从原图换成增强版时，如果新地址没被登记成"能直接画"，
 *      <img> 会先透明一帧再亮 —— 那就是我们花过一整轮才治掉的翻页闪。
 *
 * 所以两条视口各跑一遍：
 *   - 手机 390×844 @DPR3：源页 959 宽要放大到 1170，**必须**出增强图；
 *   - 窄窗 300×800 @DPR1：滚动模式是"适应宽度"，这里显示宽度只有 300，
 *     源图 959 是在**缩小**显示，浏览器自己的面积采样已经够好，**必须**一张都不出。
 *
 * 顺带量出来一条和直觉相反的事实：桌面 1400 宽的窗口下，滚动模式要把 959 的源页
 * 撑到 1400 —— 放大 1.46 倍，比手机上那 1.22 倍还狠。"桌面不需要增强"是想当然。
 *
 * 再拿 rAF 逐帧盯住第一张页图的透明度：**已经画出来之后**不许再回到透明。
 * （门控改了新语义：增强版没就绪时那一页本来就是空的，所以"第一次画之前就透明"
 * 不算闪 —— startOpacityWatch 里的 ready 正是这道分界。）
 *
 * 跑法：node scripts/verify-enhance.mjs
 * 不进 npm test：要真浏览器 + 外网。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 8895;
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN = 'baozimh';
const SLUG = 'woduzishengji-duburedicestudio';
/** 和 verify-autojump 同一本同一章：这一章的页图是 959 宽，手机上正好要放大 */
const CHAPTER = '0_113';

/** 和 src/reader/enhance.ts 的 CACHE_MAX 对齐（从源码里读，免得两边各写一个数） */
const ENHANCE_CACHE_MAX =
  Number(readFileSync(join(ROOT, 'src/reader/enhance.ts'), 'utf8').match(/CACHE_MAX = (\d+)/)?.[1]) || 12;

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const found = findBrowser();
if (!found) {
  console.error('找不到可用的浏览器');
  process.exit(2);
}
const tmp = mkdtempSync(join(tmpdir(), 'zeno-enhance-'));
const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: join(tmp, 'e.db'),
    ALLOWED_HOSTS: '',
    SYNC_TOKEN: '',
    DIST_DIR: join(ROOT, 'dist'),
  },
});
await new Promise((r) => setTimeout(r, 1500));

const plugin = JSON.parse(readFileSync(join(ROOT, 'baozimh-plugin.json'), 'utf8'));
await fetch(`${BASE}/api/sync/push`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deviceId: 'enhance',
    seq: 0,
    plugins: [{ id: plugin.meta.id, origin: 'imported', data: JSON.stringify(plugin), updatedAt: Date.now() }],
  }),
});

const browser = await chromium.launch({
  headless: true,
  executablePath: found.exe,
  args: ['--proxy-bypass-list=*.ts.net;127.0.0.1;localhost'],
});

const errors = [];
function watch(page) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 160)}`));
}

/** 全新 profile 没有"这个设备装了哪个源"，得自己种进 IndexedDB */
async function installPlugin(page) {
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
    { id: plugin.meta.id, plugin, installedAt: Date.now(), updatedAt: Date.now(), origin: 'imported' },
  );
}

/** 第一张页图的现状：地址类型、显示宽度、源图宽 */
const pageOne = (page, sel) =>
  page.evaluate(
    (s) => {
      const img = document.querySelector(s);
      if (!img) return null;
      return {
        blob: img.src.startsWith('blob:'),
        src: img.src.slice(0, 60),
        shown: Math.round(img.getBoundingClientRect().width),
        natural: img.naturalWidth,
        dpr: window.devicePixelRatio,
      };
    },
    sel,
  );

/** 逐帧盯页图的透明度：换 src 那一下不许出现 0 */
function startOpacityWatch(page, sel) {
  return page.evaluate(
    (s) =>
      new Promise((res) => {
        const state = { samples: 0, zeroAfterReady: 0, ready: false, swapped: false };
        const tick = () => {
          const img = document.querySelector(s);
          if (img) {
            const op = Number(getComputedStyle(img).opacity);
            if (op === 1 && img.naturalWidth > 0) state.ready = true;
            if (img.src.startsWith('blob:')) state.swapped = true;
            if (state.ready && op < 1) state.zeroAfterReady++;
            state.samples++;
          }
          if (state.samples < 60 * 12) requestAnimationFrame(tick);
          else res(state);
        };
        requestAnimationFrame(tick);
      }),
    sel,
  );
}

/**
 * 两种阅读方式都要跑：
 *   - 滚动模式页图是 .reader__page（width:100%，显示宽度就是容器宽）；
 *   - 分页模式是 .reader__cell img，尺寸由 object-fit 四档算出来，
 *     而且台面下是两个常驻槽位来回换 —— 增强版换 src 会不会撞上翻页动画，
 *     只有这一档量得到。
 */
/**
 * 把阅读器开在指定那一档（滚动 / 分页）。
 *
 * readerMode 是跟着同步走的键，不是本机键 —— 上一档选了分页，下一档全新 profile
 * 也会被服务端那份拉回去。所以别去裸写 localStorage（会被启动时的 pull 盖掉，
 * 踩过两回：一次污染成分页，一次钉了分页却被拉回滚动），
 * 用应用自己的那颗切换按钮，走到目标档为止。
 */
async function openInMode(page, want, label) {
  await page.waitForSelector('.reader__page, .reader__cell img', { timeout: 60_000, state: 'attached' });
  for (let i = 0; i < 2 && !(await page.evaluate((w) => !!document.querySelector(w), want)); i++) {
    await page.click('button[aria-label="切换模式"]');
    await page.waitForTimeout(1500);
  }
  try {
    await page.waitForSelector(want, { timeout: 30_000, state: 'attached' });
  } catch {
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200)).catch(() => '(读不到)');
    const counts = await page
      .evaluate(() => ({
        page: document.querySelectorAll('.reader__page').length,
        cellImg: document.querySelectorAll('.reader__cell img').length,
        mode: localStorage.getItem('readerMode'),
      }))
      .catch(() => null);
    throw new Error(`${label}：开不到要的那一档。页面上写着「${text}」 DOM 统计 ${JSON.stringify(counts)}`);
  }
}

/**
 * 设置页那一栏。单独量一条是因为「实验」是新加的一档：
 * tab 数组、?tab= 白名单、面板分支三处都要对上，少一处就是"点标签没反应"这种不报错的坏法。
 */
async function checkSettingsTab() {
  console.log('\n=== 设置 → 实验 这一栏 ===');
  const ctx = await browser.newContext({ viewport: { width: 900, height: 800 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  watch(page);
  await installPlugin(page);
  await page.goto(`${BASE}/settings?tab=experiment`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('.tabs button', { timeout: 20_000 });
  const tabs = await page.locator('.tabs button').allTextContents();
  check(tabs.includes('实验'), `标签里有「实验」这一档（${tabs.join('/')}）`);
  /* 地址里写 experiment 就该开在这一栏上，不然链接分享过去是错的栏 */
  const on = await page.evaluate(() => {
    const cur = [...document.querySelectorAll('.tabs button')].find((b) => b.getAttribute('aria-selected') === 'true' || b.className.includes('on'));
    return cur?.textContent ?? null;
  });
  check(on === '实验', `?tab=experiment 直接落在「实验」栏（实际停在「${on}」）`);
  const row = page.locator('button.pref-row', { hasText: '画面增强' });
  check((await row.count()) === 1, '这一栏里有「画面增强」');
  await row.click();
  const stored = await page.evaluate(() => localStorage.getItem('readerEnhance'));
  check(stored === '1', `从设置页点也写进同一个本机键 readerEnhance=${stored}`);
  /* 阅读那一栏不该再有它 —— 同一件事出现在两栏，改哪边都说不清 */
  await page.goto(`${BASE}/settings?tab=read`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('.tabs button', { timeout: 20_000 });
  const dup = await page.locator('button.pref-row', { hasText: '画面增强' }).count();
  check(dup === 0, `「阅读」栏里不再挂这一条（找到 ${dup} 处）`);
  await ctx.close();
}

async function run(label, viewport, opts) {
  const { expectBlob, paged } = opts;
  const errBase = errors.length;
  console.log(`\n=== ${label} ===`);
  const ctx = await browser.newContext({ ...viewport, locale: 'zh-CN' });
  const page = await ctx.newPage();
  watch(page);
  await installPlugin(page);
  /*
   * readerMode 是跟着同步走的键，不是本机键 —— 上一档选了分页，下一档全新 profile
   * 也会被服务端那份拉回去。所以别去裸写 localStorage（会被启动时的 pull 盖掉，
   * 踩过两回：一次污染成分页，一次钉了分页却被拉回滚动），
   * 用应用自己的那颗切换按钮，走到目标档为止。
   */
  const want = paged ? '.reader__cell img' : '.reader__page';
  await page.goto(`${BASE}/read/${PLUGIN}/${SLUG}/${CHAPTER}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await openInMode(page, want, label);
  const sel = want;
  await page.waitForTimeout(2500);
  /* 断言要看的是"解好码的源图有多大"，没解码时 naturalWidth 是 0，量了等于没量 */
  await page.waitForFunction(
    (s) => {
      const i = document.querySelector(s);
      return !!i && i.naturalWidth > 0 && i.getBoundingClientRect().width > 0;
    },
    sel,
    { timeout: 40_000 },
  );

  const before = await pageOne(page, sel);
  check(!!before, `${paged ? '分页' : '滚动'}模式页图渲染出来了`);
  if (expectBlob) await page.screenshot({ path: join(ROOT, 'dist/off-phone.png'), clip: { x: 0, y: 0, width: 390, height: 520 } });
  check(
    before && !before.blob,
    `开关没动时用的还是源图地址（${before?.src.slice(0, 24)}…）`,
  );

  /* 走真 UI 打开：阅读设置 → 实验功能 → 画面增强 */
  await page.click('button[aria-label="阅读设置"]');
  await page.waitForSelector('.sheet', { timeout: 5_000 });
  const row = page.locator('button.pref-row', { hasText: '画面增强' });
  check((await row.count()) === 1, '阅读设置里有「画面增强」这一行');
  await row.click();
  const stored = await page.evaluate(() => localStorage.getItem('readerEnhance'));
  check(stored === '1', `点完写进本机键 readerEnhance=${stored}（它不参与同步，所以不在 readerPrefs 那份里）`);
  await page.keyboard.press('Escape');

  /* 重进一次，让开关从头生效 */
  await page.goto(`${BASE}/read/${PLUGIN}/${SLUG}/${CHAPTER}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await openInMode(page, sel, `${label}（重进后）`);
  await page.waitForTimeout(800);
  const opacity = startOpacityWatch(page, sel);

  let after = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500);
    after = await pageOne(page, sel);
    if (after?.blob) break;
  }
  const st = await opacity;

  if (expectBlob) {
    check(!!after?.blob, `增强版换上了：${after?.natural} 宽的增强图顶上 ${after?.shown}×${after?.dpr} 的显示位`);
    check(
      !!after && Math.abs(after.natural - Math.round(after.shown * after.dpr)) <= 2,
      `增强图宽度 == 显示宽度 × DPR（${after?.natural} vs ${after && Math.round(after.shown * after.dpr)}）—— 不是随手放大一个固定倍率`,
    );
    check(st.zeroAfterReady === 0, `换图过程中 ${st.samples} 帧里透明帧 ${st.zeroAfterReady} 次（>0 就是闪）`);

    /*
     * 整章走一遍。这一条是补上的：上一版 LRU 淘汰会把**刚做好、还没被组件 pin 上**的
     * 那个地址自己 revoke 掉，于是 <img> 拿到一个失效地址 → 失败 → 重试还往 blob 后面
     * 拼 cache-buster 查询串（必然再失败）→ 一页好图变成「加载失败 · 点此重试」。
     * 50 页的章实测 85 次 blob 请求全红、35 页坏掉。
     * 只看"第一张换上了"是量不出这个的，必须走过 CACHE_MAX 张。
     */
    const blobFails = [];
    const onFail = (r) => r.url().startsWith('blob:') && blobFails.push(r.url().slice(0, 60));
    page.on('requestfailed', onFail);
    const imgSel = paged ? '.reader__cell img' : '.reader__item img';
    for (let i = 0; i < 16; i++) {
      if (paged) await page.click('.paged-tap--r');
      else
        await page.evaluate((t) => {
          const el = document.querySelector('.reader__scroll');
          if (el) el.scrollTop = t;
        }, 1200 * (i + 1));
      await page.waitForTimeout(paged ? 700 : 900);
    }
    await page.waitForTimeout(2500);
    page.off('requestfailed', onFail);
    const swept = await page.evaluate(
      (s) => ({
        imgs: document.querySelectorAll(s).length,
        blob: [...document.querySelectorAll(s)].filter((i) => String(i.src).startsWith('blob:')).length,
        broken: document.querySelectorAll('.img-fallback').length,
      }),
      imgSel,
    );
    check(blobFails.length === 0, `${paged ? '连翻 16 页' : '整章滚下来'}之后 blob 失败 ${blobFails.length} 次（有失败就是地址被撤销了）`);
    check(swept.broken === 0, `坏图 ${swept.broken} 张（在场 ${swept.imgs} 张、挂着增强版 ${swept.blob} 张）`);
    if (!paged) {
      /* 滚动模式 50 页全挂在 DOM 上，所以留存数会越过上限；分页模式台面只有两张，
         越过上限反而是错的，那一档由上面两条把关。上限跟 src/reader/enhance.ts 的 CACHE_MAX */
      check(
        swept.blob > ENHANCE_CACHE_MAX || swept.imgs <= ENHANCE_CACHE_MAX,
        `留存增强图 ${swept.blob} 张（上限 ${ENHANCE_CACHE_MAX}，在场 ${swept.imgs} 张）—— "还在显示的不许撤销"这条生效了`,
      );
    }
    check(errors.length === errBase, `走过 ${paged ? '16 次翻页' : '整章'}没有引出报错`);
    await page.screenshot({ path: join(ROOT, `dist/on-${paged ? 'paged' : 'phone'}.png`), clip: { x: 0, y: 0, width: 390, height: 520 } });
  } else {
    check(!after?.blob, `显示宽度 ${after?.shown}×${after?.dpr} = ${after && Math.round(after.shown * after.dpr)} 比源图 ${after?.natural} 还窄，是缩小显示，不该白算一张`);
  }

  /* 关掉要能退回原图 */
  await page.click('button[aria-label="阅读设置"]');
  await page.waitForSelector('.sheet', { timeout: 5_000 });
  await page.locator('button.pref-row', { hasText: '画面增强' }).click();
  const off = await page.evaluate(() => localStorage.getItem('readerEnhance'));
  check(off === '0', `再点一次退回 readerEnhance=${off}`);
  await ctx.close();
}

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

try {
  await checkSettingsTab();

  await run('手机 390×844 @DPR3 滚动：959 宽源页要放大到 1170，该出手', PHONE, { expectBlob: true });

  await run('同一本同一章切到分页：双缓冲那条路也要能换上，且翻页不闪', PHONE, {
    expectBlob: true,
    paged: true,
  });

  await run('窄窗 300×800 @DPR1：源图是缩小显示，不该出手', { viewport: { width: 300, height: 800 }, deviceScaleFactor: 1 }, {
    expectBlob: false,
  });
} catch (e) {
  console.error(`\n跑挂了：${e.message}`);
  fails++;
}

console.log(errors.length ? `\n  页面报错 ${errors.length} 条：\n    ${errors.slice(0, 6).join('\n    ')}` : '\n  页面零报错');
if (errors.length) fails++;

await browser.close();
srv.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1200));
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 留着比崩了强 */
}

console.log(fails ? `\n${fails} 条没过` : '\n全部通过 — 该出手时出手，不该出手时不浪费');
process.exit(fails ? 1 : 0);
