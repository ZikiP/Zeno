/**
 * 设置分栏 + 多源启用 的走查
 *
 * 覆盖三件事：
 *  1. 设置页那五个栏都能打开、都能滚、键盘能在栏间移动、?tab= 能深链；
 *     「关于」里的版本号是真的（构建期注入，不是手写的）。
 *  2. 一个源只有启用/停用两种状态，能同时启用多个：发现页的切换器换得了站，
 *     书架把两个源的书合在一起，跨源搜索默认全搜；停用的那个从这几处都消失，
 *     但记录还在，重新打开原样回来。启用集合会同步，浏览位置不会。
 *  3. 详情页与阅读器按地址里的 pluginId 取规则 —— 看着 A 源也能打开 B 源的书，
 *     这是以前那个"这一章没有图片"的坑。
 *
 * 跑法：node scripts/verify-settings.mjs [--keep]
 * 需要：本机 chromium 系浏览器 + 能上网（会真的抓两个站的列表、详情各一次）。
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

const loadMeta = (path) => JSON.parse(readFileSync(path, 'utf8')).meta;
const A = existsSync(A_PLUGIN) ? loadMeta(A_PLUGIN) : null;
const B = existsSync(B_PLUGIN) ? loadMeta(B_PLUGIN) : null;
const BOTH = !!(A && B);

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

const overflow = async (where) => {
  const o = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }));
  check(o.scrollW <= o.innerW + 1, `${where} 无横向溢出（${o.scrollW} ≤ ${o.innerW}）`);
};

/**
 * 直接写启用集合与浏览位置。
 *
 * 走 localStorage 而不是点开关：这两处都要验，点开关的那条在 §7 里，
 * 这里只是把界面摆到某个已知状态，省掉一堆等待。
 * 键必须跟 src/store/plugins.ts 一致 —— 名字错了这个走查就白跑。
 */
const setSources = async (ids, browse) => {
  await page.evaluate(
    ([v, b]) => {
      localStorage.setItem('enabledPluginIds', v.join(','));
      localStorage.setItem('enabledPluginIds__at', String(Date.now()));
      localStorage.setItem('browsePluginId', b ?? v[0]);
      localStorage.removeItem('activePluginId');
    },
    [ids, browse],
  );
};

/**
 * 读每个源开关的状态：aria-checked（语义）与 .on（看得见的那点绿）两个都读。
 *
 * 只断言前者的话，"状态确实改了、开关却纹丝不动"这种 bug 会一路绿灯 ——
 * 真踩过一次：.switch 的填充色和圆点位移全挂在 .switch.on 上，
 * 渲染时漏了这个类，界面上看就是"点了没反应"。
 */
const switchRows = async () =>
  page.$$eval('.plugin-row', (els) =>
    els.map((el) => {
      const sw = el.querySelector('.switch');
      return {
        name: sw?.getAttribute('aria-label') ?? '',
        on: sw?.getAttribute('aria-checked') === 'true',
        filled: !!sw && sw.classList.contains('on'),
      };
    }),
  );

const cardsInfo = () =>
  page.evaluate(() => ({
    n: document.querySelectorAll('a.card').length,
    first: document.querySelector('a.card')?.getAttribute('href') ?? '',
  }));
/** 等列表出结果。两个站的抓取快慢差一个量级（包子是直连，拷贝要渲染），给足时间 */
const waitCards = (ms = 120_000) =>
  page
    .waitForFunction(() => document.querySelectorAll('a.card').length > 0, null, { timeout: ms, polling: 400 })
    .then(() => true)
    .catch(() => false);

if (BOTH) {
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
  await overflow(key);
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

if (BOTH) {
  console.log('\n=== 5. 两个源都启用：默认全开、发现页能换站');
  /*
   * 这台是全新库，从没写过 enabledPluginIds —— 按规则「装上的都算启用」，
   * 所以两个源的开关该都是开的。这条是迁移语义，不是巧合。
   */
  await page.goto(`${BASE}/settings?tab=sources`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.plugin-row .switch', { timeout: 20_000 });
  const rows = await switchRows();
  check(
    rows.length === 2 && rows.every((r) => r.on && r.filled),
    `装了两个源就默认启用两个，开关看着也是开的：${rows.map((r) => `${r.name}=aria:${r.on}/绿:${r.filled}`).join(' / ')}`,
  );

  await setSources([A.id, B.id], A.id);
  await page.goto(`${BASE}/explore`, { waitUntil: 'domcontentloaded' });
  /* 启用集合要等首轮同步把插件带下来才数得出两个，切换器是那时候才出现的 */
  await page.waitForSelector('.source-switch .chip', { timeout: 30_000 }).catch(() => {});
  const chips = await page.$$eval('.source-switch .chip', (els) => els.map((e) => e.textContent?.trim()));
  check(chips.length === 2, `发现页顶部有源切换器：${chips.join(' / ')}`);
  check(await waitCards(), `${A.name} 的列表出结果`);
  const aInfo = await cardsInfo();
  check(aInfo.first.startsWith(`/comic/${A.id}/`), `${A.name} 的详情地址带着自己的源：${aInfo.first}`);

  await page.click(`.source-switch .chip:has-text("${B.name}")`);
  await page.waitForTimeout(400);
  check(await waitCards(), `${B.name} 的列表出结果（切过去是真的换了源，不是换个标签）`);
  const bInfo = await cardsInfo();
  check(bInfo.first.startsWith(`/comic/${B.id}/`), `${B.name} 的详情地址：${bInfo.first}`);
  const browse = await page.evaluate(() => localStorage.getItem('browsePluginId'));
  check(browse === B.id, `在看哪个源记在 browsePluginId（${browse}）`);
  await page.screenshot({ path: join(shots, 'explore-switched.png'), fullPage: true });

  console.log('\n=== 6. 看着 B 源，直接打开 A 源的书');
  await page.goto(`${BASE}${aInfo.first}`, { waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(() => document.querySelectorAll('a[href*="/read/"]').length > 0, null, { timeout: 120_000 })
    .catch(() => {});
  const chapterCount = await page.evaluate(() => document.querySelectorAll('a[href*="/read/"]').length);
  check(chapterCount > 0, `浏览的是 ${B.id}，打开 ${A.id} 的书仍拿到 ${chapterCount} 条章节`);
  const title = await page.$eval('.detail__title, h1, h2', (el) => el.textContent?.trim()).catch(() => '');
  check(!!title && title !== aInfo.first.split('/').pop(), `标题是这本书自己的（${title}）`);
  await page.screenshot({ path: join(shots, 'cross-source-detail.png'), fullPage: true });

  const readHref = await page.$eval('a[href*="/read/"]', (el) => el.getAttribute('href'));
  await page.click(`a[href="${readHref}"]`);
  const painted = await page
    .waitForFunction(
      () => [...document.querySelectorAll('img')].some((i) => i.complete && i.naturalWidth > 200),
      null,
      { timeout: 150_000, polling: 300 },
    )
    .then(() => true)
    .catch(() => false);
  check(painted, '再点进它的一章，图片真的画出来了（这就是以前那句"这一章没有图片"）');
  await page.screenshot({ path: join(shots, 'cross-source-reader.png') });

  console.log('\n=== 7. 书架合两个源的书；停用一个之后两处都不见');
  /*
   * 两个源各往书架放一本。详情页要等动作行出来（拷贝漫画那一本还得先渲染），
   * 所以等的是按钮上的字，不是"页面上有按钮"。
   */
  const addShelf = async (url) => {
    await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
    const got = await page
      .waitForFunction(
        () => [...document.querySelectorAll('button.btn')].some((b) => b.textContent?.includes('加入书架')),
        null,
        { timeout: 120_000, polling: 400 },
      )
      .then(() => true)
      .catch(() => false);
    if (got) await page.click('button.btn:has-text("加入书架")');
    check(got, `${url} 上找到「加入书架」并点了`);
    await page.waitForTimeout(800);
  };
  await addShelf(aInfo.first);
  await addShelf(bInfo.first);

  await page.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const shelf1 = await page.$$eval('a.card', (els) => els.map((e) => e.getAttribute('href') ?? ''));
  check(
    shelf1.length >= 2 && shelf1.some((h) => h.startsWith(`/comic/${A.id}/`)) && shelf1.some((h) => h.startsWith(`/comic/${B.id}/`)),
    `两个源的书同时在书架上（${shelf1.length} 本：${shelf1.join(' ')}）`,
  );
  await page.screenshot({ path: join(shots, 'shelf-both.png'), fullPage: true });

  /* 两个源都开着：跨源搜索的范围条该把两个都列出来，且默认全选 */
  await page.goto(`${BASE}/search`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const bothChips = await page.$$eval('.filters .chip', (els) =>
    els.map((e) => ({ text: e.textContent?.trim() ?? '', on: e.className.includes('on') })),
  );
  check(
    bothChips.length === 2 && bothChips.every((c) => c.on) && bothChips.some((c) => c.text.includes(A.name)) &&
      bothChips.some((c) => c.text.includes(B.name)),
    `跨源搜索默认把两个启用的源都勾上：${bothChips.map((c) => `${c.text}=${c.on}`).join(' / ')}`,
  );

  /* 用界面点开关，而不是写 localStorage：这条验的就是那个按钮 */
  await page.goto(`${BASE}/settings?tab=sources`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.plugin-row .switch', { timeout: 20_000 });
  await page.click(`.switch[aria-label="启用 ${B.name}"]`);
  await page.waitForTimeout(900);
  const stored = await page.evaluate(() => localStorage.getItem('enabledPluginIds'));
  check(stored === A.id, `关掉 ${B.name} 之后启用集合只剩 ${A.id}（实际「${stored}」）`);
  /* 点下去得看得见：语义翻了、开关那颗也得跟着变灰，不然就是"点了没反应" */
  const rowsAfterOff = await switchRows();
  check(
    rowsAfterOff.every((r) => r.on === r.filled),
    `开关的外观跟着状态走：${rowsAfterOff.map((r) => `${r.name}=aria:${r.on}/绿:${r.filled}`).join(' / ')}`,
  );
  await page.screenshot({ path: join(shots, 'sources-one-off.png'), fullPage: true });

  await page.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const shelf2 = await page.$$eval('a.card', (els) => els.map((e) => e.getAttribute('href') ?? ''));
  check(
    shelf2.length > 0 && shelf2.every((h) => h.startsWith(`/comic/${A.id}/`)),
    `书架只剩 ${A.id} 的书（${shelf2.length} 本），停用的那个源被藏起来了`,
  );

  await page.goto(`${BASE}/explore`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const switcher = await page.$$('.source-switch .chip');
  check(switcher.length === 0, '只剩一个源时切换器整条不出现（不该摆一排只有一个能点的 chip）');
  /*
   * browsePluginId 里还写着刚被停用的那个源（没人去清它），
   * 但发现页该自动退到启用的那一个，而不是停在"这个源没启用"的死页上。
   */
  const stillBrowses = await page.evaluate(() => localStorage.getItem('browsePluginId'));
  check(await waitCards(), `停用在看的源之后，发现页退到还启用的那个（browsePluginId 仍是「${stillBrowses}」）`);
  const afterOff = await cardsInfo();
  check(afterOff.first.startsWith(`/comic/${A.id}/`), `退过去读的是 ${A.id} 的列表：${afterOff.first}`);

  /*
   * 停用的源不该还能被跨源搜索捞回来。
   * 只剩一个源时这一栏本来就不显示（一个 chip 的"范围条"没意义），
   * 所以判的是"绝不含 B"，而不是"必须含 A"。
   */
  await page.goto(`${BASE}/search`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const searchChips = await page.$$eval('.filters .chip', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  check(
    !searchChips.some((t) => t.includes(B.name)),
    `搜索范围里不再有停用的 ${B.name}（现在列出：${searchChips.join(' / ') || '只剩一个源，范围条不显示'}）`,
  );

  /* 重新打开：书架该原样回来，说明停用真的只是藏起来 */
  await page.goto(`${BASE}/settings?tab=sources`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.plugin-row .switch', { timeout: 20_000 });
  await page.click(`.switch[aria-label="启用 ${B.name}"]`);
  await page.waitForTimeout(900);
  await page.goto(`${BASE}/shelf`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const shelf3 = await page.$$eval('a.card', (els) => els.length);
  check(shelf3 === shelf1.length, `重新启用后书架回到 ${shelf3} 本（没丢记录）`);

  /*
   * 启用集合是配置，该跟着同步出去；在看哪个源不是，不该出去。
   *
   * 这一条以前测的是"老键 activePluginId 怎么迁移"，但在会同步的设备上测不准：
   * 刚把本地键删掉，下一轮 pull 就从服务端把值原样填回来了。
   * 迁移那套判断改由 scripts/test-enabled.ts 直接对着真实现跑。
   */
  console.log('\n=== 8. 启用集合同步得出去，浏览位置不留到别的设备');
  await page.goto(`${BASE}/settings?tab=sync`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const nowBtn = await page.$('button:has-text("保存并立即同步")');
  check(!!nowBtn, '同步栏上有「保存并立即同步」可以按');
  if (nowBtn) {
    await nowBtn.click();
    await page.waitForTimeout(3000);
  }
  const snap = await (await fetch(`${BASE}/api/sync/pull?since=0`)).json();
  const syncRows = snap.settings ?? [];
  const carried = syncRows.find((s) => s.key === 'enabledPluginIds');
  check(
    !!carried && String(carried.value).split(',').length === 2,
    `服务端收到了启用集合（${carried?.value ?? '没有这一项'}）`,
  );
  check(
    !syncRows.some((s) => s.key === 'browsePluginId'),
    '在看哪个源没被同步出去 —— 手机上看着拷貝漫畫，不该把平板的发现页也换掉',
  );
  await page.screenshot({ path: join(shots, 'sources-synced.png'), fullPage: true });
  await setSources([A.id, B.id], A.id);

  console.log('\n=== 9. 点名一个没装的源，要说清楚而不是弹走');
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
console.log(fails === 0 ? '\n多源启用与设置分栏走查通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
