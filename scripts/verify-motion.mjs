/**
 * 动效逐帧验证
 *
 * 翻页这类问题看静态截图看不出来 —— 得把动画拆成一串帧，
 * 一帧一帧看它到底连不连续。这里同时做两件事：
 *
 *   1. **客观**：动画期间每一帧统计舞台上"有几张图片在场"。
 *      旧版闪的根因就是 React 就地换页，中间有一帧舞台上是空的 ——
 *      数字上会掉到 0，肉眼看到的就是闪白（黑底上是黑一下）。
 *   2. **主观**：把一次翻页按固定间隔截成一组帧图，落盘给人看。
 *      另外再演一遍"放慢 5 倍"的版本，帧与帧之间的差别才看得出来。
 *   3. **每一档**：翻页动画三档（无 / 平移 / 翻页）各跑一遍前进和回退，
 *      外加"没选过时的默认档跟系统减少动效走"这一条。
 *      顺带验真正跑起来的是哪组关键帧 —— 只查 class 会被别处样式表悄悄改写，
 *      上一版就是这么漏的。
 *
 * 跑法：node scripts/verify-motion.mjs [--keep]
 * 依赖本机浏览器 + 外网（要真的抓一章图）。不进 npm test。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 8894;
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN = join(ROOT, 'baozimh-plugin.json');
const KEEP = process.argv.includes('--keep');

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

if (!existsSync(PLUGIN)) {
  console.error(`需要 ${PLUGIN} 才能抓到真章节`);
  process.exit(2);
}
const found = findBrowser();
if (!found) {
  console.error('找不到可用的浏览器');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'zeno-motion-'));
const shots = join(tmp, 'frames');
mkdirSync(shots);

const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(tmp, 'm.db'), ALLOWED_HOSTS: '', SYNC_TOKEN: '' },
});
process.on('exit', () => {
  try {
    srv.kill();
  } catch {
    /* 已退 */
  }
});

for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 150));
}
const raw = readFileSync(PLUGIN, 'utf8');
await fetch(`${BASE}/api/sync/push`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deviceId: 'motion',
    seq: 0,
    plugins: [{ id: JSON.parse(raw).meta.id, origin: 'imported', data: raw, updatedAt: Date.now() }],
  }),
});

/*
 * 舞台上有几张图 —— 必须把双缓冲那个还没露面的槽位排除掉。
 *
 * 那个槽位用 visibility:hidden 留着上一页（就是为了下次不用重新解码），
 * 它是真实存在的 <img>：算进来的话"空帧"永远测不出来，Playwright 等"图片可见"
 * 也会因为先命中这张隐藏图而一直等不到（约一半概率，看这次轮到哪个槽位当台面）。
 */
const LIVE_IMG = '.reader__spread:not(.is-hidden) img';

const ctx = await chromium.launchPersistentContext(join(tmp, 'profile'), {
  executablePath: found.exe,
  headless: true,
  viewport: { width: 412, height: 915 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

/*
 * "往某方向翻"对应点哪一边。
 *
 * 右起时前进是点左区 —— 脚本里硬写 --r 会在右起站点上点成后退，
 * 第一页退不动，于是采样采到的是"什么都没发生"，
 * 看着像动画坏了，其实是测试自己点错了边。
 */
const tapZone = (dir) =>
  page.evaluate(
    (wantForward) => {
      const rtl = /右起/.test(document.querySelector('.reader__bar')?.textContent ?? '');
      const forward = wantForward ? !rtl : rtl;
      return forward ? 'r' : 'l';
    },
    dir === 'forward',
  );

/**
 * 从 computed transform 里取出绕 Y 轴的实际角度，以及横向位移量。
 *
 * 不要用 getBoundingClientRect().width 判断翻页连不连续 —— 带 perspective 的
 * 投影矩形在 70~90° 之间会先缩到零再涨回来（抬起那条边被透视放大了），
 * 于是"单调旋转"会被量成"反弹"。matrix3d 的 [0]=cosθ、[8]=sinθ，
 * 直接反解角度才是真相。位移同理，取 matrix 的 tx 分量而不是 rect.left。
 */
async function sampleTurn({ dir = 'forward', slowFactor = 1, budget = 900 } = {}) {
  if (slowFactor !== 1) {
    await page.addStyleTag({
      content: `:root{--d-flip:${Math.round(420 * slowFactor)}ms !important;--d-slide:${Math.round(300 * slowFactor)}ms !important}`,
    });
  }
  const zone = await tapZone(dir);
  return page.evaluate(
    ({ zone, ms }) => {
      /*
       * 一次把旋转角和横向位移都解出来，三档动画共用这套采样：
       * 折页看 deg 单不单调，平移看 x 单不单调，无那一档两个都不该出现。
       */
      const parts = (el) => {
        const m = /^(?:matrix3d|matrix)\(([^)]+)\)$/.exec(getComputedStyle(el).transform ?? '');
        if (!m) return { deg: 0, x: 0 };
        const v = m[1].split(',').map(Number);
        const wide = v.length >= 16;
        return {
          /* matrix(2D) 时 v[0]=cos、v[2]=sin、tx=v[4]；matrix3d 时是 v[0]、v[8]、tx=v[12] */
          deg: Math.round(Math.atan2(wide ? v[8] : v[2], v[0]) * (180 / Math.PI) * 10) / 10,
          x: Math.round(wide ? v[12] : v[4]),
        };
      };
      return new Promise((done) => {
        const stage = document.querySelector('.reader__paged');
        /*
         * 只盯「离场那一层」：它从 0 走到 ±整整一页，是单调性最好的信号。
         * 注意 querySelector 是按文档顺序返回的，两层都在动时它不认选择器先后 ——
         * 所以先单独找 leave，再退回折页和 enter。
         */
        const moving = () =>
          stage.querySelector('.slide-leave') ??
          stage.querySelector('.turn-out,.turn-in') ??
          stage.querySelector('.slide-enter');
        const out = [];
        let t0 = 0;
        const record = () => {
          const imgs = [...stage.querySelectorAll('.reader__spread:not(.is-hidden) img')];
          const mv = moving();
          const mvParts = mv ? parts(mv) : null;
          out.push({
            /* 时间戳不能取整：两帧只差 1ms 时，取整会把速率放大十倍，量出假"跳帧" */
            t: Math.round((performance.now() - t0) * 10) / 10,
            n: imgs.length,
            anim: stage.dataset.anim ?? '?',
            cls: mv ? mv.className.replace('reader__spread', '').trim() : null,
            /*
             * 实际跑起来的关键帧名字。这一条专门盯着"被别处的样式表悄悄改写"：
             * 上一版就是 a11y 在 reduce 下把折页换成 page-fade，屏幕上什么都不转，
             * 只看 class 和 data-turn 全都正常，根本查不出来。
             */
            an: mv ? getComputedStyle(mv).animationName : null,
            deg: mvParts ? mvParts.deg : null,
            x: mvParts ? mvParts.x : null,
            /* 演动画这一层自己的宽度 —— 平移要量"走满一页没有" */
            w: mv ? Math.round(mv.getBoundingClientRect().width) : 0,
            /*
             * 有几张图还在透明状态。翻页闪白（这里是闪黑，底色是黑的）的
             * 真正来源就是这个：新页刚挂载时 opacity 是 0，露出来的那一帧
             * 是空的。动画曲线再怎么调都治不了它 —— 得让图片以"已就绪"
             * 的状态挂载。
             */
            dim: imgs.filter((im) => Number(getComputedStyle(im).opacity) < 0.99).length,
            p: document.querySelector('.reader__bar')?.textContent?.match(/\d+ \/ \d+/)?.[0] ?? '?',
            s: imgs
              .map((im) => (im.currentSrc || im.src).replace(/^.*\/([^/]+?)\.jpg.*$/, '$1'))
              .join('+'),
          });
        };
        /*
         * 基线必须在点之前取：点击的 onClick 是同步的，React 状态当场就变了，
         * 从第一帧才开始采会把"翻了一页"这件事整个漏掉。
         */
        record();
        t0 = performance.now();
        document.querySelector(`.paged-tap--${zone}`).click();
        const tick = () => {
          record();
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else done(out);
        };
        requestAnimationFrame(tick);
      });
    },
    { zone, ms: budget },
  );
}

const frameShots = async (label, count, gap) => {
  for (let i = 0; i < count; i++) {
    await page.screenshot({ path: join(shots, `${label}-${String(i).padStart(2, '0')}.png`) });
    if (i < count - 1) await page.waitForTimeout(gap);
  }
};

/**
 * 一条 cubic-bezier 缓动的最大斜率（相对匀速）。
 *
 * 用它当"跳帧"的尺子：曲线本身中段就比平均快好几倍（--e-turn 是 2.6 倍），
 * 拿匀速的固定倍数去卡，要么天天误报、要么形同虚设。超过曲线允许的峰值才算跳。
 */
function easePeakSlope([x1, y1, x2, y2]) {
  let mx = 0;
  for (let i = 0; i <= 2000; i++) {
    const t = i / 2000;
    const dx = 3 * (1 - t) ** 2 * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
    const dy = 3 * (1 - t) ** 2 * y1 + 6 * (1 - t) * t * (y2 - y1) + 3 * t * t * (1 - y2);
    if (dx > 0) mx = Math.max(mx, dy / dx);
  }
  return mx;
}

/**
 * 逐帧判一次翻页。三档各有各的"单调"要看：
 *
 *   翻页 —— 演动画那层绕书脊从 0° 转到侧立（回退反过来），看旋转角；
 *   平移 —— 离场那层从原位走到整整一页宽，看横向位移；
 *   无   —— 压根不该出现动画层，只验"没演 + 只翻一页 + 没空帧"。
 *
 * 判"跳没跳"看的是按时间归一的速率，不是相邻两帧的差值（理由见 report 里那段）；
 * 中途反向就是过冲回弹。
 */
function report(frames, dir) {
  const anim = frames[0].anim;
  const label = `${anim}·${dir}`;
  const isFlip = anim === 'flip';
  const during = frames.filter((f) => f.cls);
  const empty = frames.filter((f) => f.n === 0).length;
  const span = during.length ? during.at(-1).t - during[0].t : 0;
  /*
   * 页号单独看：只看轨迹的话，"多演了一次翻页"会伪装成"动画不单调"。
   * 一次点击应当只让页号变一次。
   */
  const pageAt = (f) => Number(f.p.match(/^\d+/)?.[0] ?? NaN);
  const pageChanges = frames.slice(1).filter((f, i) => pageAt(f) !== pageAt(frames[i])).length;

  console.log(
    `  [${label}] ${frames.length} 帧 / ${frames.at(-1).t}ms，其中 ${during.length} 帧在演动画（${span}ms），动画层 ${during[0]?.cls ?? '无'}`,
  );
  console.log('  页号：', pageAt(frames[0]), '→', pageAt(frames.at(-1)), `（变了 ${pageChanges} 次）`);
  check(empty === 0, `${label}：没有"空帧"（舞台上 0 张图的帧共 ${empty} 个）`);
  check(pageChanges === 1, `${label}：一次点击只翻一页（页号变了 ${pageChanges} 次）`);
  /*
   * 这一条才是"闪"的直接证据：动画再平滑，只要露出来的那一页有哪怕
   * 一帧是透明的，用户看到的就是一次闪烁。
   */
  const dimFrames = frames.filter((f) => f.dim > 0);
  check(
    dimFrames.length === 0,
    dimFrames.length
      ? `${label}：有 ${dimFrames.length} 帧存在透明图片（首现于 ${dimFrames[0].t}ms）—— 会闪`
      : `${label}：全程没有透明帧（露出来的那一页一直是实的）`,
  );

  if (anim === 'none') {
    check(during.length === 0, `${label}：「无」这一档确实什么都不演（演了 ${during.length} 帧）`);
    return;
  }

  check(during.length > 8, `${label}：前后两页同时在场 ${during.length} 帧 / ${span}ms`);
  /*
   * 真跑起来的是哪组关键帧 —— 只查 class 会被"悄悄改写"骗过去，
   * 上一版就是这么漏的（见 record 里那段注释）。
   */
  const names = [...new Set(during.map((f) => f.an))];
  console.log(`  [${label}] 关键帧：`, names.join(' / '));
  check(
    names.every((n) => (isFlip ? /^page-(lift|lay)$/.test(n) : /^page-(leave|enter)$/.test(n))),
    `${label}：演的是${isFlip ? '折页' : '平移'}那组关键帧，没被别处的样式表改写（${names.join(' / ')}）`,
  );

  /* 折页量角度，平移量位移，两者都是"离原点越来越远/越来越近"的一条单调曲线 */
  const track = (f) => (isFlip ? Math.abs(f.deg) : Math.abs(f.x));
  const vals = during.map(track);
  /* 往前翻是掀起来（角度涨），往后翻是落下去（角度缩）；平移两种都是离场那页越走偏远 */
  const growing = isFlip ? dir === 'forward' : true;
  const width = during.find((f) => f.w > 0)?.w ?? 0;
  /*
   * 速率要按时间归一，并且取 95 分位而不是最大值。
   *
   * 直接比"相邻两帧差多少"量的其实是采样密度：headless 里偶发掉一帧，两帧间隔从
   * 16ms 变 33ms，差值当场翻倍，于是曲线明明平滑也报"跳帧"。改成按毫秒归一以后
   * 还剩一个坑：单帧最大值同样是采样毛刺的放大器（同一份代码连跑两次，最大值在
   * 0.56 和 1.11 之间跳），而真"跳帧"是整段都走得快 —— 95 分位两头都对。
   */
  const rates = [];
  let backwards = 0;
  for (let i = 1; i < during.length; i++) {
    const dt = during[i].t - during[i - 1].t;
    const d = vals[i] - vals[i - 1];
    /* 同一帧里被回调两次（dt≈0）会把速率炸成无穷大，那不是跳帧是采样噪声 */
    if (dt >= 4) rates.push(Math.abs(d) / dt);
    if (Math.abs(d) > (isFlip ? 1 : 2) && d > 0 !== growing) backwards++;
  }
  rates.sort((a, b) => a - b);
  const peak = rates.length ? rates[Math.min(rates.length - 1, Math.floor(rates.length * 0.95))] : 0;
  /* 匀速走完这一趟的速率，再乘上曲线本身允许的峰值 */
  const cruise = (isFlip ? 90 : width) / (span || 1);
  const limit = cruise * easePeakSlope([0.35, 0.05, 0.2, 1]) * 1.3;
  console.log(
    `  ${isFlip ? '旋转角' : '位移px'}轨迹：`,
    during.filter((_, i) => i % 4 === 0).map(track).join(' '),
  );
  console.log(
    `  95 分位速率 ${peak.toFixed(2)}，曲线允许的峰值 ${(cruise * 2.61).toFixed(2)} ${isFlip ? '°/ms' : 'px/ms'}（匀速 ${cruise.toFixed(2)}）`,
  );
  check(
    peak < limit,
    `${label}：没有任何一帧跑得比这条缓动允许的更快（95 分位 ${peak.toFixed(2)} vs 上限 ${limit.toFixed(2)}）`,
  );
  check(backwards === 0, `${label}：没有反向回弹（${backwards} 次）`);
  check(
    during.length > 1 && (growing ? vals.at(-1) : vals[0]) > (isFlip ? 85 : width * 0.9),
    isFlip
      ? `${label}：转到了侧立再收摊（起始 ${vals[0]}°、结束 ${vals.at(-1)}°），撤掉那一帧不会留下半张纸`
      : `${label}：离场那页走满了整整一页（起点 ${vals[0]}px、终点 ${vals.at(-1)}px，屏宽 ${width}px）`,
  );
}

console.log('\n=== 1. 进阅读器（分页模式）===');
await page.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('readerMode', 'paged'));
await page.goto(`${BASE}/explore`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.card', { timeout: 120_000 });
await page.locator('.card').first().click();
await page.waitForURL(/\/comic\//, { timeout: 20_000 });
await page.waitForSelector('.chapter-row', { timeout: 120_000 });
/*
 * 挑正中间那一章。
 *
 * 两头都不能要：序章只有一两张图（翻不动、退不动，测不出任何东西），
 * 而"最后一章"到底是序章还是最新话，取决于站点列表是正序还是倒序 ——
 * 列表顺序一变，这个脚本就会在一张永远加载不完的图上超时。
 * 中间那一章不管哪种顺序都是正文，图多、前后都翻得动。
 */
const rows = await page.locator('.chapter-row').count();
await page.locator('.chapter-row').nth(Math.floor(rows / 2)).click();
await page.waitForURL(/\/read\//, { timeout: 20_000 });
/*
 * 图取不到就直接说清楚，别拿两分钟的超时当结论。
 *
 * 这个脚本要真章节、真图片，所以它同时依赖上游站点活着 —— 站点反爬开始返回
 * 403 时（2026-10-16 实测 baozimh 就是），这里会一直等一张永远加载不完的 <img>，
 * 报出来的却是"翻页动画没验到"。那是环境，不是动效坏了。
 */
try {
  await page.waitForSelector(LIVE_IMG, { timeout: 60_000 });
} catch {
  console.error(
    '\n图片始终没加载出来 —— 大概率是上游站点拒了（反爬 / 403），不是阅读器坏了。\n' +
      '先单独确认能不能抓到章节（例如 curl 站点页与一张图的返回码），再回来跑动效验证。',
  );
  process.exit(2);
}
await page.waitForTimeout(2500);
console.log('  章节已载入，当前屏图片数：', await page.locator(LIVE_IMG).count());

/*
 * 三档各测一遍。
 *
 * 换档必须重载页面：turnAnim 在挂载时读一次就定住了，不重载测的还是上一档 ——
 * 而"设了没生效"恰恰是这次最容易出的错。
 */
const readerUrl = page.url();
async function useTier(tier) {
  await page.evaluate((t) => localStorage.setItem('readerTurnAnim', t), tier);
  await page.goto(readerUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(LIVE_IMG, { timeout: 120_000 });
  await page.waitForTimeout(1500);
  const onStage = await page.evaluate(() => document.querySelector('.reader__paged')?.dataset.anim);
  check(onStage === tier, `切到「${tier}」后舞台上生效的就是这一档（实际 ${onStage}）`);
}

for (const tier of ['flip', 'slide', 'none']) {
  console.log(`\n=== 2.${tier} 翻页动画「${tier}」 ===`);
  await useTier(tier);

  const fwd = await sampleTurn({ dir: 'forward', budget: 900 });
  report(fwd, 'forward');

  await page.waitForTimeout(400);
  const back = await sampleTurn({ dir: 'back', budget: 900 });
  report(back, 'back');

  if (tier === 'none') break;
  /* 帧图只在会动的两档上截 —— 「无」没有中间帧可看 */
  await page.waitForTimeout(400);
  const slowP = sampleTurn({ slowFactor: 5, budget: 2800 });
  await frameShots(`${tier}`, 9, 280);
  await slowP;
  console.log(`  帧图已存 ${shots}`);
}

/*
 * 没选过时那一次默认值。这一条是这次改动的主要卖点：
 * 上一版是样式表在 reduce 下把折页改成交叉淡入，界面看不出来、也没法解释，
 * 现在改成只在"从没选过"时决定档位，选过之后完全按用户选的来。
 */
console.log('\n=== 2c. 没选过时的默认档跟随系统「减少动效」 ===');
await page.evaluate(() => localStorage.removeItem('readerTurnAnim'));
await page.goto(readerUrl, { waitUntil: 'domcontentloaded' });
await page.waitForSelector(LIVE_IMG, { timeout: 120_000 });
const { reduced, onStage } = await page.evaluate(() => ({
  reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
  onStage: document.querySelector('.reader__paged')?.dataset.anim,
}));
check(
  onStage === (reduced ? 'slide' : 'flip'),
  `系统 reduce=${reduced} 时默认档为 ${reduced ? 'slide' : 'flip'}（实际 ${onStage}）`,
);
/*
 * 这一台机器上系统「减少动效」到底开没开，直接决定上面那组折页测试算不算
 * 在 reduce 环境下验过 —— 开着还照样演折页，才是这次要的结果。
 */
console.log(`  本机系统 reduce=${reduced}；开着也照样演折页，见上面 flip 那组的关键帧`);
console.log(`  帧图已存 ${shots}`);

console.log('\n=== 4. 底栏选中态与按压态 ===');
await page.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.bottom-nav a', { timeout: 20_000 });
await page.screenshot({ path: join(shots, 'nav-idle.png'), clip: await page.locator('.bottom-nav').boundingBox() });
const navState = await page.evaluate(() => {
  const a = [...document.querySelectorAll('.bottom-nav a')];
  const pick = (el) => {
    const svg = el.querySelector('svg');
    const cs = getComputedStyle(el);
    const pill = getComputedStyle(el, '::before');
    return {
      label: el.textContent.trim(),
      active: el.classList.contains('active'),
      color: cs.color,
      weight: cs.fontWeight,
      stroke: getComputedStyle(svg).strokeWidth,
      svgOpacity: getComputedStyle(svg).opacity,
      pillBg: pill.backgroundColor,
      pillW: pill.width,
    };
  };
  return a.map(pick);
});
for (const n of navState) {
  console.log(
    `  ${n.active ? '●' : '○'} ${n.label.padEnd(3)} 色=${n.color} 字重=${n.weight} 描边=${n.stroke} 图标不透明度=${n.svgOpacity} 胶囊=${n.pillW}/${n.pillBg}`,
  );
}
const on = navState.find((n) => n.active);
const off = navState.find((n) => !n.active);
check(!!on && !!off, '底栏有且仅有一个选中项');
check(on.stroke !== off.stroke, `选中图标更粗（${on.stroke} vs ${off.stroke}）`);
check(on.weight !== off.weight, `选中标签字重不同（${on.weight} vs ${off.weight}）`);
check(on.svgOpacity !== off.svgOpacity, `未选中图标被压暗（${off.svgOpacity} vs ${on.svgOpacity}）`);
check(on.pillW !== 'auto' && on.pillW !== '0px', `选中项有胶囊底（${on.pillW}）`);

/* 按压态：用 :active 选择器量不到（要真人按），改成直接读规则是否存在 */
const press = await page.evaluate(() => {
  let icon = false;
  let nav = false;
  let bounce = false;
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const r of rules) {
      const sel = r.selectorText ?? '';
      if (sel === '.icon-btn:active') icon = true;
      if (sel === '.bottom-nav a:active svg') nav = true;
      if (sel === '.icon-btn:not(:active)' && /transform/.test(r.style.cssText)) bounce = true;
    }
  }
  return { icon, nav, bounce };
});
console.log('  按压规则：', JSON.stringify(press));
check(press.icon && press.nav, '图标与底栏都有按下缩放规则');
check(press.bounce, '松手回弹规则在（按下去快、弹回来带过冲）');

console.log('\n=== 4b. 滚动条不占布局 ===');
for (const route of ['/shelf', '/explore', '/settings']) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const squeeze = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const scrollY = el.scrollHeight > el.clientHeight + 1;
      const scrollX = el.scrollWidth > el.clientWidth + 1;
      if (!scrollY && !scrollX) continue;
      const cs = getComputedStyle(el);
      /* offsetWidth - clientWidth 含边框，减掉才是滚动条真正吃掉的宽度 */
      const border = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      const taken = Math.round(el.offsetWidth - el.clientWidth - border);
      if (taken > 0) out.push({ where: el.className || el.tagName, taken });
    }
    return out;
  });
  check(
    squeeze.length === 0,
    `${route} 没有滚动条占位${squeeze.length ? `：${JSON.stringify(squeeze)}` : ''}`,
  );
}

console.log('\n=== 5. 页面切换动画确认已移除 ===');
const vt = await page.evaluate(() => ({
  hook: !!document.querySelector('[data-vt-active]'),
  // 转场文件删了以后不该再有任何 view-transition 相关规则
  rules: [...document.styleSheets].some((s) => {
    try {
      return [...s.cssRules].some((r) => (r.cssText ?? '').includes('view-transition'));
    } catch {
      return false;
    }
  }),
}));
check(!vt.rules, '样式表里已经没有 view-transition 规则');
check(errors.length === 0, `无浏览器报错${errors.length ? `：${errors.slice(0, 3).join(' | ')}` : ''}`);

console.log(fails === 0 ? '\n动效验证通过' : `\n${fails} 项失败`);
await ctx.close();
srv.kill();
await new Promise((r) => setTimeout(r, 300));
console.log(`帧图：${shots}`);
if (!KEEP) rmSync(tmp, { recursive: true, force: true });
else console.log(`（--keep：${tmp} 保留）`);
process.exit(fails === 0 ? 0 : 1);
