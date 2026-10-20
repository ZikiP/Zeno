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
import { Worker } from 'node:worker_threads';
import { openDb } from './db.mjs';
import { installedPlugins } from './plugins.mjs';
import { fetchPage, fill, modeFor } from './plugin-page.mjs';
import { renderLoad } from './render.mjs';
import { json, readBody } from './respond.mjs';
import { countChapters, listChapters } from './chapter-parse.mjs';

/* 测试直接调用它们；实现搬到 chapter-parse，worker 也引同一份 */
export { countChapters, listChapters };

const ROUND_MS = Number(process.env.ZENO_UPDATE_CHECK_MS ?? 12 * 3600_000);
const PER_BOOK_MS = Number(process.env.ZENO_UPDATE_BOOK_MS ?? 6 * 3600_000);
const GAP_MS = Number(process.env.ZENO_UPDATE_GAP_MS ?? 500);
/** 启动后多久跑第一轮。刚起来那会儿用户在用，别抢渲染槽 */
const STARTUP_DELAY_MS = Number(process.env.ZENO_UPDATE_START_DELAY_MS ?? 60_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 单本书的章节解析上限；正常 500 章只要几毫秒 */
const PARSE_TIMEOUT_MS = Math.max(200, Number(process.env.PARSE_TIMEOUT_MS || 3_000));

/**
 * 章节解析放进 worker。
 *
 * 插件里的 chapterIdFrom 是原样正则，嵌套量词写坏就能在 Node 主线程里卡死
 * 整个服务。worker 里跑、超时直接 terminate，至少只损失这一次解析。
 */
function parseChaptersSafe(html, parse) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL('./parse-worker.mjs', import.meta.url), {
      workerData: { html, parse },
    });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('章节解析超时（插件正则可能有灾难性回溯）')),
      PARSE_TIMEOUT_MS,
    );
    worker.once('message', (m) => {
      if (m?.ok) finish(resolve, m.list);
      else finish(reject, new Error(m?.error || '章节解析失败'));
    });
    worker.once('error', (e) => finish(reject, e));
    worker.once('exit', (code) => {
      if (code !== 0) finish(reject, new Error(`章节解析 worker 退出（${code}）`));
    });
  });
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
  const { html } = await fetchPage(plugin, url, 'detail', { background: true });
  // 详情页没有 capture 这条路；真拿到了 JSON 就当"没数出来"，别拿空串去写 0
  return html;
}

/**
 * 跑一轮。
 *
 * force 是给"现在就要看一眼"那个按钮的：跳过每本 6 小时那一道闸。
 * 一轮里任何一本失败都不中断别的 —— 一个站挂了不该让整轮作废。
 */
let running = null;

/**
 * 定时轮单飞；手动 force 每次都起一条新的。
 *
 * 手动按钮的语义是「现在、以我手上的书架为准再看一遍」。如果复用一条在它之前
 * 就已经开始的轮次，刚加进书架的书永远不在那一轮的书单里 —— 测试和真实使用
 * 都会看到「按了检查，新书没动」。代价是手动与定时可能短暂重叠，用户主动按的
 * 那一下优先。
 */
export function runUpdateCheck(opts = {}) {
  if (opts.force) return runUpdatesOnce({ ...opts, force: true });
  if (running) return running;
  const p = runUpdatesOnce({ ...opts, force: false }).finally(() => {
    if (running === p) running = null;
  });
  running = p;
  return p;
}

async function runUpdatesOnce({ force = false } = {}) {
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
    const prev = d.prepare('SELECT anchors, checked_at, chapter_ids FROM updates WHERE key = ?').get(key);
    /*
     * 6 小时那道闸是给"重复数同一本"省事的，不是给"从来没存过章节表"开脱的。
     * 不写这一条的话，升级到有了 chapter_ids 的版本之后，每本书都得等到自己
     * 那道 6 小时闸门过期才补上表 —— 追漫于是整整半天在空转，而健康检查全绿、
     * 界面上一切正常。判据得看"有没有"，不能只看"上次查过没有"。
     */
    /* 失败过的书不享受 6 小时闸门：下一轮/下一次手动检查要能重试 */
    if (
      !force &&
      prev &&
      prev.chapter_ids != null &&
      !prev.error &&
      Date.now() - prev.checked_at < PER_BOOK_MS
    ) {
      summary.skipped++;
      continue;
    }
    const plugin = byId.get(b.pluginId);
    if (!plugin) {
      summary.skipped++;
      continue;
    }
    /*
     * 后台追更让位给正在渲染的用户请求。browser 模式才有这一步；
     * fetch 模式不占渲染槽，照常数。
     */
    if (modeFor(plugin, 'detail') === 'browser' && renderLoad().openPages > 0) {
      summary.paused = 'render-busy';
      break;
    }

    let anchors = null;
    let ids = null;
    let error = null;
    try {
      const url = new URL(fill(plugin.urls.detail, { slug: b.slug }), plugin.entry).toString();
      const html = await fetchDetailHtml(plugin, url);
      const list = await parseChaptersSafe(html, plugin.parse);
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
    /*
     * force 由请求方说，不再一律强制。
     *
     * 以前这颗端点恒为 force:true，于是"非强制那一轮会怎么走"这条路径在 HTTP 上
     * 根本跑不到 —— 想测那道 6 小时闸门都测不了（写出来的断言物理上不可能失败）。
     * 定时那一轮走的是 runUpdateCheck() 默认值，跟这里同一条判断。
     */
    const body = await readBody(req, 8 * 1024);
    const force = body?.force === true;
    json(res, 202, { started: true, force });
    void runUpdateCheck({ force }).catch((e) => console.warn(`[zeno] 追更检查失败：${e?.message ?? e}`));
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
