/**
 * 追更检查：替书架上的每本书数一次"现在有多少章"
 *
 * 为什么服务端来做：追更要抓详情页才知道有没有新章，而这台机器本来就是常驻的。
 * 放在客户端的话，"打开应用才能知道有新章"这件事本身就违背目的。
 *
 * 为什么只记**条数**这一个签名，不记章节列表：
 * 解析层（src/site/parse.ts）跑在浏览器包里，服务端不该养第二套完整解析。
 * 条数足够回答"有没有变、多了几章"，而徽章上的数字是
 * 「服务端的条数 − 客户端手里那份的条数」，两边必须是同一个单位 ——
 * 所以 countChapters 是照着 parseChapters 一条条对齐写的，
 * 有一条测试拿真实页面产物把两边钉在一起（scripts/test-updates.mjs）。
 * 少对齐一条规则的后果是每本书都挂着一个假的"+4"，永远消不掉。
 *
 * 礼貌边界（都是可关的）：默认 12 小时一轮，同一本最少隔 6 小时才再看，
 * 一本一本串着取、每本之间停 500ms，渲染槽在忙就这一轮收工。
 */
import { openDb } from './db.mjs';
import { installedPlugins } from './plugins.mjs';
import { escapeRe, fetchPage, fill } from './plugin-page.mjs';
import { json, readBody } from './respond.mjs';

const ROUND_MS = Number(process.env.ZENO_UPDATE_CHECK_MS ?? 12 * 3600_000);
const PER_BOOK_MS = Number(process.env.ZENO_UPDATE_BOOK_MS ?? 6 * 3600_000);
const GAP_MS = Number(process.env.ZENO_UPDATE_GAP_MS ?? 500);
/** 启动后多久跑第一轮。刚起来那会儿用户在用，别抢渲染槽 */
const STARTUP_DELAY_MS = Number(process.env.ZENO_UPDATE_START_DELAY_MS ?? 60_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 和 src/site/text.ts 的 decodeEntities 一条不差。
 *
 * 为什么服务端要自己再来一遍：客户端 fetchText 拿到 HTML 先做这个解码、再交给
 * parseChapters，而服务端在这里是直接在原始 HTML 上数的 —— 少这一步，
 * 一个 `&#47;` 写法的地址在两边就是两种结果，差值变成一个永远消不掉的假徽章。
 * 这份复制是故意的，而且是**被测试钉住的**：scripts/test-updates.ts 拿
 * 完整的客户端管线（解码 → 解析）跟这里的 countChapters 比条数，谁改了另一边就红。
 */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/**
 * 数出详情页里的章节条数。
 *
 * 规则逐条对齐 parseChapters：`<a …章节项…>` 开标签、href 可能在标签上也可能在
 * 内层、`&amp;`/`&#x2F;` 要先还原、按 chapterIdFrom 取出的 id 去重。
 * 条数就是 listChapters 的长度 —— 徽章那边只用到条数，追漫才用到 id 和顺序，
 * 两件事必须出自同一份解析，不然"数到 183"和"表里 183 条"能对上才见鬼。
 */
export function countChapters(html, parse) {
  return listChapters(html, parse).length;
}

/**
 * 章节表：id + 阅读顺序，按 index 升序。
 *
 * 这是 parseChapters 的第二份实现，**故意的**，跟 decodeEntities 同一条路：
 * 解析层跑在浏览器包里，服务端不为了一个函数去引前端构建物。两份的一致性由
 * scripts/test-updates.ts 钉 —— 它拿同一份 HTML 让两边各跑一遍，逐条比 id 和 index，
 * 谁改了另一边就红。
 *
 * index 的来路和客户端一条不差：id 正则捕到两组以上时，第二组就是序号
 * （`section_slot=0&chapter_slot=562` → `0_562`，**页面顺序未必是章节顺序**）；
 * 只捕到一组时这站没有分区/序号的概念（UUID 形态地址），只能按它们在页面里
 * 出现的先后排。追漫靠这个顺序决定"最近 K 章"是哪 K 章，抄错方向就是把窗口
 * 摆到几百章之前。
 */
export function listChapters(html, parse) {
  const body = decodeEntities(html);
  const itemRe = new RegExp(`<a[^>]*${escapeRe(parse.chapterItem)}[^>]*>([\\s\\S]{0,300}?)</a>`, 'gi');
  const idRe = new RegExp(parse.chapterIdFrom);
  const out = [];
  const seen = new Set();
  let m;
  while ((m = itemRe.exec(body))) {
    const inner = m[1] ?? '';
    const attrs = m[0].slice(0, m[0].indexOf('>'));
    const hrefM = attrs.match(/href="([^"]+)"/) ?? inner.match(/href="([^"]+)"/);
    if (!hrefM) continue;
    const href = hrefM[1].replace(/&amp;/g, '&').replace(/&#x2F;/g, '/');
    const idM = href.match(idRe);
    if (!idM) continue;
    const numbered = idM.length >= 3;
    const raw = numbered ? idM[2] : idM[1];
    if (!raw) continue;
    const id = numbered ? `${idM[1] ?? '0'}_${raw}` : raw;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, index: numbered ? Number(raw) || 0 : out.length + 1 });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

/**
 * 取详情页正文。
 *
 * waitFor 和 minCount 必须一起给，两样都得跟着客户端那份走 —— 少一样就等着看差别：
 * 拷貝漫畫的目录里 SSR 先挂 1 条占位、JS 再灌进 20+ 条，只等"出现过"就拿回来 1 条，
 * 数出来的条数和客户端解析出来的对不上，减法那边就永远是个负数（实测这么测出来的，
 * 三个源里两个都是 1）。规则本身在 plugin-page.mjs，跟追漫共用一份。
 */
async function fetchDetailHtml(plugin, url) {
  const { html } = await fetchPage(plugin, url, 'detail');
  // 详情页没有 capture 这条路；真拿到了 JSON 就当"没数出来"，别拿空串去写 0
  return html;
}

/**
 * 跑一轮。
 *
 * force 是给"现在就要看一眼"那个按钮的：跳过每本 6 小时那一道闸。
 * 一轮里任何一本失败都不中断别的 —— 一个站挂了不该让整轮作废。
 */
export async function runUpdateCheck({ force = false } = {}) {
  const d = openDb();
  const books = d
    .prepare(
      `SELECT s.plugin_id AS pluginId, s.slug AS slug FROM shelf s
       WHERE EXISTS (SELECT 1 FROM plugins p WHERE p.id = s.plugin_id)
       ORDER BY s.added_at ASC`,
    )
    .all();
  const byId = new Map(installedPlugins().map((p) => [p.meta.id, p]));
  const summary = { checked: 0, changed: 0, failed: 0, skipped: 0 };

  for (const b of books) {
    const key = `${b.pluginId}/${b.slug}`;
    const prev = d.prepare('SELECT anchors, checked_at FROM updates WHERE key = ?').get(key);
    if (!force && prev && Date.now() - prev.checked_at < PER_BOOK_MS) {
      summary.skipped++;
      continue;
    }
    const plugin = byId.get(b.pluginId);
    if (!plugin) {
      summary.skipped++;
      continue;
    }

    let anchors = null;
    let ids = null;
    let error = null;
    try {
      const url = new URL(fill(plugin.urls.detail, { slug: b.slug }), plugin.entry).toString();
      const html = await fetchDetailHtml(plugin, url);
      const list = listChapters(html, plugin.parse);
      anchors = list.length;
      // 数组的顺序就是阅读顺序（listChapters 末尾按 index 升序排过），追漫靠它定窗口
      ids = JSON.stringify(list.map((c) => ({ id: c.id, index: c.index })));
      // 一条都没数到多半是页面没拿到（质询、改版），不该写成"这书没章节了"
      if (anchors === 0) {
        error = '没数到任何章节';
        anchors = null;
        ids = null;
      }
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 160);
    }

    /*
     * anchors / chapter_ids 取不到时都保持旧值（COALESCE），否则一次网络抖动会把基线
     * 抹成 null，下一轮成功时就变成"从 0 涨到 183"，书架上凭空冒出一个假的新章徽章。
     */
    d.prepare(
      `INSERT INTO updates (key, plugin_id, slug, anchors, chapter_ids, checked_at, changed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET
         anchors = COALESCE(excluded.anchors, updates.anchors),
         chapter_ids = COALESCE(excluded.chapter_ids, updates.chapter_ids),
         checked_at = excluded.checked_at,
         changed_at = CASE
           WHEN updates.anchors IS NOT NULL AND excluded.anchors IS NOT NULL
                AND updates.anchors <> excluded.anchors THEN excluded.checked_at
           ELSE updates.changed_at
         END,
         error = excluded.error`,
    ).run(key, b.pluginId, b.slug, anchors, ids, Date.now(), error);

    summary.checked++;
    if (error) summary.failed++;
    else if (prev?.anchors != null && anchors !== prev.anchors) summary.changed++;

    await sleep(GAP_MS);
  }
  return summary;
}

export function listUpdates() {
  return openDb()
    .prepare('SELECT key, plugin_id, slug, anchors, checked_at, changed_at, error FROM updates')
    .all()
    .map((r) => ({
      key: r.key,
      pluginId: r.plugin_id,
      slug: r.slug,
      anchors: r.anchors,
      checkedAt: r.checked_at,
      changedAt: r.changed_at,
      error: r.error,
    }));
}

/**
 * 客户端翻开了一本书 → 基线跟它对齐，徽章该清零。
 *
 * 用客户端报来的条数而不是"现在的 anchors"：客户端那份是真的解析出来、
 * 也是它接下来要拿去算进度的数。两边对齐后徽章自己就消失了。
 */
export function markSeen(key, anchors) {
  const d = openDb();
  const now = Date.now();
  const had = d.prepare('SELECT key FROM updates WHERE key = ?').get(key);
  if (had) d.prepare('UPDATE updates SET anchors = ?, changed_at = NULL, checked_at = ? WHERE key = ?').run(anchors, now, key);
  else {
    const [pluginId, ...rest] = String(key).split('/');
    d.prepare('INSERT INTO updates (key, plugin_id, slug, anchors, checked_at, changed_at, error) VALUES (?, ?, ?, ?, ?, NULL, NULL)').run(
      key,
      pluginId,
      rest.join('/'),
      anchors,
      now,
    );
  }
}

let timer = null;

export function startUpdateScheduler() {
  if (ROUND_MS <= 0) return null;  const tick = async () => {
    try {
      const s = await runUpdateCheck();
      if (s.checked) console.log(`[zeno] 追更检查：看了 ${s.checked} 本，${s.changed} 本有新章，${s.failed} 本没取到`);
    } catch (e) {
      // 一句 stderr 不该把服务搞挂，也不该让下一轮不再排
      console.warn(`[zeno] 追更检查失败：${e?.message ?? e}`);
    }
  };
  timer = setTimeout(() => {
    void tick();
    // 上一轮跑完之后再排下一次，别让它自己叠上去
    const repeat = () => {
      timer = setTimeout(() => void tick().finally(repeat), ROUND_MS);
      timer.unref?.();
    };
    repeat();
  }, STARTUP_DELAY_MS);
  timer.unref?.();
  // 把节奏告诉调用方，启动横幅才说得清"这东西开着、多久跑一次"
  return { roundMs: ROUND_MS, perBookMs: PER_BOOK_MS };
}

export function stopUpdateScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * GET /api/updates · POST /api/updates/check · POST /api/updates/seen
 *
 * 返回 false 表示"不是我的路由"，跟 handleCacheApi 同一个约定 ——
 * index.mjs 那条链靠返回值决定要不要继续往下走。这里要是每个分支都
 * `return json(...)`（它没有返回值），每个请求都会穿过这段、最后掉到静态文件
 * 那里回一个 404 的 HTML，界面上看就是"接口莫名 404"。
 */
export async function handleUpdatesApi(req, res, url, auth) {
  if (!url.pathname.startsWith('/api/updates')) return false;
  if (!auth(req)) {
    json(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (url.pathname === '/api/updates' && req.method === 'GET') {
    json(res, 200, { items: listUpdates(), roundMs: ROUND_MS, perBookMs: PER_BOOK_MS });
    return true;
  }

  /*
   * 手动这一轮是 force 的（跳过每本 6 小时那道闸），因为是用户按出来的。
   * 一轮几十秒（一本一本串着取），所以先把 202 发回去、这一轮在后台跑完 ——
   * 把请求吊在那儿，界面上就只剩一个转圈，什么也不告诉人。
   */
  if (url.pathname === '/api/updates/check' && req.method === 'POST') {
    json(res, 202, { started: true });
    void runUpdateCheck({ force: true }).catch((e) => console.warn(`[zeno] 追更检查失败：${e?.message ?? e}`));
    return true;
  }

  if (url.pathname === '/api/updates/seen' && req.method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    const key = String(body?.key ?? '');
    const anchors = Number(body?.anchors);
    if (!key.includes('/') || !Number.isFinite(anchors) || anchors < 0) {
      json(res, 400, { error: '要 key（pluginId/slug）和非负的 anchors' });
      return true;
    }
    markSeen(key, anchors);
    json(res, 200, { ok: true });
    return true;
  }

  json(res, 404, { error: 'not found' });
  return true;
}
