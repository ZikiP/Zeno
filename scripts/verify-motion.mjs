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
 * 从 computed transform 里取出绕 Y 轴的实际角度。
 *
 * 不要用 getBoundingClientRect().width 判断翻页连不连续 —— 带 perspective 的
 * 投影矩形在 70~90° 之间会先缩到零再涨回来（抬起那条边被透视放大了），
 * 于是"单调旋转"会被量成"反弹"。matrix3d 的 [0]=cosθ、[8]=sinθ，
 * 直接反解角度才是真相。
 */
async function sampleTurn({ dir = 'forward', slowFactor = 1, budget = 900 } = {}) {
  if (slowFactor !== 1) {
    await page.addStyleTag({
      content: `:root{--d-flip:${Math.round(520 * slowFactor)}ms !important}`,
    });
  }
  const zone = await tapZone(dir);
  return page.evaluate(
    ({ zone, ms }) => {
      const angle = (el) => {
        const t = getComputedStyle(el).transform;
        const m = /^(?:matrix3d|matrix)\(([^)]+)\)$/.exec(t ?? '');
        if (!m) return 0;
        const v = m[1].split(',').map(Number);
        /* matrix(2D) 时 v[0]=cos、v[2]=sin；matrix3d 时是 v[0] 与 v[8] */
        const [c, s] = v.length >= 16 ? [v[0], v[8]] : [v[0], v[2]];
        return Math.round(Math.atan2(s, c) * (180 / Math.PI) * 10) / 10;
      };
      return new Promise((done) => {
        const stage = document.querySelector('.reader__paged');
        const out = [];
        let t0 = 0;
        const record = () => {
          const imgs = [...stage.querySelectorAll('.reader__spread img')];
          const over = stage.querySelector('.reader__spread.is-over');
          out.push({
            t: Math.round(performance.now() - t0),
            n: imgs.length,
            over: !!over,
            deg: over ? angle(over) : null,
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
 * 逐帧判一次翻页。
 *
 * 前进时演动画那层从 0° 转到侧立（|deg| 一路涨到 90），回退反过来。
 * 判"连不连续"要看角度而不是投影宽度，理由见 sampleTurn 上面那段。
 * 每帧步长超过 15° 就是肉眼可见的"跳"，反向超过 1° 就是过冲回弹。
 */
function report(frames, dir) {
  const growing = dir === 'forward';
  const during = frames.filter((f) => f.over && f.deg !== null);
  const empty = frames.filter((f) => f.n === 0).length;
  const degs = during.map((f) => Math.abs(f.deg));
  let maxStep = 0;
  let backwards = 0;
  for (let i = 1; i < degs.length; i++) {
    const d = degs[i] - degs[i - 1];
    maxStep = Math.max(maxStep, Math.abs(d));
    if (Math.abs(d) > 1 && d > 0 !== growing) backwards++;
  }
  const span = during.length ? during.at(-1).t - during[0].t : 0;
  /*
   * 页号单独看：只看角度的话，"多演了一次翻页"会伪装成"动画不单调"。
   * 一次点击应当只让页号变一次。
   */
  const pageAt = (f) => Number(f.p.match(/^\d+/)?.[0] ?? NaN);
  const pageChanges = frames.slice(1).filter((f, i) => pageAt(f) !== pageAt(frames[i])).length;
  console.log(`  ${frames.length} 帧 / ${frames.at(-1).t}ms，其中 ${during.length} 帧两页同时在场（${span}ms）`);
  console.log('  旋转角轨迹：', during.filter((_, i) => i % 4 === 0).map((f) => f.deg).join(' '));
  console.log('  页号：', pageAt(frames[0]), '→', pageAt(frames.at(-1)), `（变了 ${pageChanges} 次）`);
  check(during.length > 8, `${dir}：前后两页同时在场 ${during.length} 帧 / ${span}ms`);
  check(empty === 0, `${dir}：没有"空帧"（舞台上 0 张图的帧共 ${empty} 个）`);
  check(maxStep < 15, `${dir}：单帧最大转角步长 ${maxStep.toFixed(1)}°，没有跳帧`);
  check(backwards === 0, `${dir}：没有反向回弹（${backwards} 次）`);
  check(pageChanges === 1, `${dir}：一次点击只翻一页（页号变了 ${pageChanges} 次）`);
  /*
   * 这一条才是"闪"的直接证据：动画再平滑，只要露出来的那一页有哪怕
   * 一帧是透明的，用户看到的就是一次闪烁。
   */
  const dimFrames = during.filter((f) => f.dim > 0);
  check(
    dimFrames.length === 0,
    dimFrames.length
      ? `${dir}：有 ${dimFrames.length} 帧存在透明图片（首现于 ${dimFrames[0].t}ms）—— 会闪`
      : `${dir}：全程没有透明帧（露出来的那一页一直是实的）`,
  );
  check(
    degs.length > 1 && (growing ? degs.at(-1) > 85 : degs[0] > 85),
    `${dir}：转到了侧立再收摊（起始 ${degs[0]}°、结束 ${degs.at(-1)}°），撤掉那一帧不会留下半张纸`,
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
 * 挑最后一章。第一章往往是"序章"，只有一两张图 ——
 * 在那种章节上翻页测不出什么，还会因为退不动而误判成"动画坏了"。
 */
const rows = await page.locator('.chapter-row').count();
await page.locator('.chapter-row').nth(rows - 1).click();
await page.waitForURL(/\/read\//, { timeout: 20_000 });
await page.waitForSelector('.reader__paged img', { timeout: 120_000 });
await page.waitForTimeout(2500);
console.log('  章节已载入，当前屏图片数：', await page.locator('.reader__spread img').count());

console.log('\n=== 2. 真实速度往前翻一页，逐帧统计 ===');
const fwd = await sampleTurn({ dir: 'forward', budget: 900 });
report(fwd, 'forward');

console.log('\n=== 2b. 往回翻一页（另一条动画路径）===');
await page.waitForTimeout(400);
const back = await sampleTurn({ dir: 'back', budget: 900 });
report(back, 'back');

console.log('\n=== 3. 放慢 5 倍，截一组帧图给人看 ===');
await page.waitForTimeout(400);
const slowP = sampleTurn({ slowFactor: 5, budget: 2800 });
await frameShots('turn', 9, 280);
await slowP;
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
