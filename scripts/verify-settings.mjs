/**
 * 设置分栏 + 跨内容源深链 的走查
 *
 * 覆盖两件事：
 *  1. 设置页那五个栏都能打开、都能滚、键盘能在栏间移动、?tab= 能深链；
 *     「关于」里的版本号是真的（构建期注入，不是手写的）。
 *  2. 书架/详情页/阅读器的地址带 pluginId 之后，**激活着 A 源也能打开 B 源的书** ——
 *     这是以前那个"这一章没有图片"的坑，全局搜索还为此先偷偷切一次源。
 *
 * 跑法：node scripts/verify-settings.mjs [--keep]
 * 需要：本机 chromium 系浏览器 + 能上网（会真的抓一次两个站的详情页）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../server/render.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.VERIFY_PORT || 8795);
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = process.argv.includes('--keep');
const A_PLUGIN = join(ROOT, 'baozimh-plugin.json');
const B_PLUGIN = resolve(ROOT, '../zeno-plugins/plugins/copymanga.json');

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const tmp = mkdtempSync(join(tmpdir(), 'zeno-settings-'));
const shots = join(tmp, 'shots');
mkdirSync(shots);

const srv = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: join(tmp, 's.db'),
    ALLOWED_HOSTS: '',
    SYNC_TOKEN: '',
    DIST_DIR: join(ROOT, 'dist'),
  },
});
const errors = [];
const found = findBrowser();
if (!found) {
  console.error('找不到可用的浏览器');
  srv.kill();
  process.exit(2);
}

for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 150));
}

const push = async (path) => {
  const p = JSON.parse(readFileSync(path, 'utf8'));
  const res = await fetch(`${BASE}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'settings-verify',
      seq: 0,
      plugins: [{ id: p.meta.id, origin: 'imported', data: JSON.stringify(p), updatedAt: Date.now() }],
    }),
  });
  return (await res.json()).ok === true;
};

const browser = await chromium.launch({ headless: true, executablePath: found.exe });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 140)}`));

const overflow = () =>
  page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }));
const setActive = (id) => page.evaluate((v) => localStorage.setItem('activePluginId', v), id);
const noOverflow = (where) =>
  overflow().then((o) => check(o.scrollW <= o.innerW + 1, `${where} 无横向溢出（${o.scrollW} ≤ ${o.innerW}）`));

if (existsSync(A_PLUGIN) && existsSync(B_PLUGIN)) {
  check((await push(A_PLUGIN)) && (await push(B_PLUGIN)), '两个内容源都推到服务端（一个也不该在应用里内置）');
} else {
  console.log(`  缺插件文件（${A_PLUGIN} / ${B_PLUGIN}），只做设置页走查`);
}

console.log('\n=== 1. 五个栏都能打开');
await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.tabs [role=tab]', { timeout: 20_000 });
const tabLabels = await page.$$eval('.tabs [role=tab]', (els) => els.map((e) => e.textContent));
check(
  JSON.stringify(tabLabels) === JSON.stringify(['外观', '内容源', '缓存', '同步', '关于']),
  `分栏是这五个：${tabLabels.join(' / ')}`,
);

for (const key of ['appearance', 'sources', 'cache', 'sync', 'about']) {
  await page.click(`#tab-${key}`);
  await page.waitForTimeout(900);
  const shown = await page.$eval('.tab-panel', (el) => el.textContent?.trim().slice(0, 40) ?? '');
  const url = new URL(page.url()).searchParams.get('tab');
  check(shown.length > 4, `${key} 栏有内容（开头「${shown}」）`);
  check(url === key, `${key} 栏写回了地址（?tab=${url}）`);
  await noOverflow(key);
  await page.screenshot({ path: join(shots, `settings-${key}.png`), fullPage: true });
}

console.log('\n=== 2. 键盘能切换分栏');
await page.goto(`${BASE}/settings?tab=appearance`, { waitUntil: 'domcontentloaded' });
await page.focus('#tab-appearance');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(400);
check(new URL(page.url()).searchParams.get('tab') === 'sources', '右方向键走到「内容源」并改了地址');
check(await page.evaluate(() => document.activeElement?.id === 'tab-sources'), '焦点跟着走到新栏（不会掉在隐藏按钮上）');
await page.keyboard.press('End');
await page.waitForTimeout(400);
check(new URL(page.url()).searchParams.get('tab') === 'about', 'End 走到最后一栏');

console.log('\n=== 3. 深链到某一栏 + 状态条入口');
await page.goto(`${BASE}/settings?tab=cache`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
check(await page.$eval('[role=tabpanel]', (el) => el.textContent?.includes('缓存目录') ?? false), '?tab=cache 直接落到缓存栏');
await page.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const bar = await page.$('.sync-bar');
if (bar) {
  await bar.click();
  await page.waitForTimeout(900);
  check(
    new URL(page.url()).pathname === '/settings' && new URL(page.url()).searchParams.get('tab') === 'sync',
    `点同步状态条落到「同步」栏（当前 ${page.url().replace(BASE, '')}）`,
  );
} else {
  check(false, '没看到同步状态条（这台没配服务端地址时本来就没有，算通过要看实际）');
}

console.log('\n=== 4. 关于里的版本号是真的');
const expectVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
await page.goto(`${BASE}/settings?tab=about`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
const aboutText = await page.$eval('[role=tabpanel]', (el) => el.textContent ?? '');
check(aboutText.includes(expectVersion), `关于报的版本与 package.json 一致（${expectVersion}）`);

console.log('\n=== 5. 激活着 A 源，也能打开 B 源的书');
if (existsSync(A_PLUGIN) && existsSync(B_PLUGIN)) {
  await setActive('baozimh');
  await page.goto(`${BASE}/explore`, { waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(() => document.querySelectorAll('a.card').length > 0, null, { timeout: 90_000 })
    .catch(() => {});
  const baoziPath = await page.evaluate(() => document.querySelector('a.card')?.getAttribute('href') ?? null);
  check(!!baoziPath, `包子漫画的详情地址 ${baoziPath}`);

  if (baoziPath) {
    /* 换成另一个源当激活，再直接开这个地址 —— 以前这样会拿错的规则去解析同一个 slug */
    await setActive('copymanga');
    await page.goto(`${BASE}${baoziPath}`, { waitUntil: 'domcontentloaded' });
    await page
      .waitForFunction(() => document.querySelectorAll('a[href*="/read/"]').length > 0, null, { timeout: 90_000 })
      .catch(() => {});
    const chapterCount = await page.evaluate(() => document.querySelectorAll('a[href*="/read/"]').length);
    check(chapterCount > 0, `激活 copymanga 时打开 baozimh 的书，仍然拿到 ${chapterCount} 条章节`);
    const title = await page.$eval('.detail__title, h1, h2', (el) => el.textContent?.trim()).catch(() => '');
    check(!!title && title !== baoziPath.split('/').pop(), `标题是这本书自己的（${title}）`);
    await page.screenshot({ path: join(shots, 'cross-source-detail.png'), fullPage: true });

    const readHref = await page.$eval('a[href*="/read/"]', (el) => el.getAttribute('href'));
    await page.click(`a[href="${readHref}"]`);
    const painted = await page
      .waitForFunction(
        () => [...document.querySelectorAll('img')].some((i) => i.complete && i.naturalWidth > 200),
        null,
        { timeout: 120_000, polling: 300 },
      )
      .then(() => true)
      .catch(() => false);
    check(painted, '再点进它的一章，图片真的画出来了（这就是以前那句"这一章没有图片"）');
    await page.screenshot({ path: join(shots, 'cross-source-reader.png') });
  }

  console.log('\n=== 6. 点名一个没装的源，要说清楚而不是弹走');
  await page.goto(`${BASE}/comic/notinstalled/at-all`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const missing = await page.evaluate(() => document.body.innerText.includes('没有') || document.body.innerText.includes('没装'));
  check(missing && new URL(page.url()).pathname === '/comic/notinstalled/at-all', '留在原地址并说明"这台设备没这个源"');
  await page.screenshot({ path: join(shots, 'missing-source.png') });
}

check(errors.length === 0, `控制台没有报错${errors.length ? `：\n   - ${errors.slice(0, 6).join('\n   - ')}` : ''}`);

await browser.close();
srv.kill();
await new Promise((r) => setTimeout(r, 300));
console.log(`\n截图在 ${shots}`);
if (!KEEP) rmSync(tmp, { recursive: true, force: true });
else console.log(`（--keep：临时目录保留 ${tmp}）`);
console.log(fails === 0 ? '\n设置分栏与跨源深链走查通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
