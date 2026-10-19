/**
 * 预热的保留策略：每本只留「未读的最近 K 章」，其余按各自的到期时间腾盘
 *
 * 为什么删得要有护栏：这些字节全可再生（翻到时现取就是），但删错一刀的代价是用户
 * 正好翻到那一张 —— 这一章于是又慢回去。三条护栏：
 *   1. 还被别的行引用的地址不删（两本书共用一张图，或同一章重铺过一次）
 *   2. 客户端最近报过进度的章不删（那就是正在读的那几章）
 *   3. 每一行都有自己的到期时间，没到就一动不动
 *
 * 已读判定用的那个 95 在 warm-store.mjs，跟 updates.mjs 抄 decodeEntities、
 * warm-resolve 抄 getChapter 同一条路：服务端不为了一个常数去引浏览器包。
 */
import { openDb } from './db.mjs';
import { cacheKeyOf, dropEntry, entryOf } from './cache-store.mjs';
import { READ_AT } from './warm-store.mjs';

/** 读完的章过了这一段时间才真删字节。量的是"读完那一刻"，见下面的 dueAt */
const READ_GRACE_MS = Number(process.env.ZENO_WARM_READ_GRACE_MS || 24 * 3600_000);
/** 取消追漫 / 移出书架之后留多久反悔。过了这一天才动刀 */
const UNFOLLOW_GRACE_MS = Number(process.env.ZENO_WARM_UNFOLLOW_GRACE_MS || 24 * 3600_000);
/** 客户端在这时间内报过进度的章，字节不动刀 */
const RECENT_MS = Number(process.env.ZENO_WARM_RECENT_MS || 24 * 3600_000);
/** 铺失败（error）的章过了这么久重新排队：多半只是上游那一刻抽风 */
const RETRY_MS = Number(process.env.ZENO_WARM_RETRY_MS || 24 * 3600_000);

/**
 * 这本书还在用的章，按客户端给的序号排；没序号的排在后面，照进台账的先后。
 * "该不该留"由 warm-ledger 的计划说了算，这里只负责把它们摆出来给它看。
 */
function liveRows(d, pluginId, slug) {
  return d
    .prepare(
      `SELECT * FROM warm WHERE plugin_id = ? AND slug = ? AND state IN ('queued','running','done')
       ORDER BY CASE WHEN idx IS NULL THEN 1 ELSE 0 END, idx ASC, updated_at ASC`,
    )
    .all(pluginId, slug);
}

/**
 * 扫一遍。plan 是 warm-ledger 的 followedBooks() —— 该留哪几章由它一处算，
 * 这里只照着执行，不再自己算第二遍"最近 K 章"。
 *
 * 一轮做三件事：整本级的到期标记（打上/撤销）、把不该留的章标掉、把到期了的删干净。
 */
export async function sweepWarm(plan) {
  const d = openDb();
  const now = Date.now();
  const out = { dropped: 0, freed: 0, files: 0, requeued: 0, scheduled: 0, cancelled: 0 };
  const byBook = new Map(plan.map((b) => [`${b.pluginId}/${b.slug}`, b]));

  out.requeued = d
    .prepare('UPDATE warm SET state = ?, updated_at = ? WHERE state = ? AND updated_at < ?')
    .run('queued', now, 'error', now - RETRY_MS).changes;

  const books = d.prepare('SELECT DISTINCT plugin_id, slug FROM warm').all();

  /* ── 1. 整本级：不追了 / 不在架 → 排上一天后清；追回来了 → 撤销 ── */
  for (const b of books) {
    const followed = byBook.has(`${b.plugin_id}/${b.slug}`);
    if (followed) {
      out.cancelled += d
        .prepare('UPDATE warm SET purge_at = NULL WHERE plugin_id = ? AND slug = ? AND purge_at IS NOT NULL')
        .run(b.plugin_id, b.slug).changes;
      continue;
    }
    out.scheduled += d
      .prepare('UPDATE warm SET purge_at = ? WHERE plugin_id = ? AND slug = ? AND purge_at IS NULL')
      .run(now + UNFOLLOW_GRACE_MS, b.plugin_id, b.slug).changes;
  }

  /* ── 2. 章级：不在窗口里的那些，标成不留 ── */
  for (const b of plan) {
    // 还没数出章节表：不知道该留谁，这一本原样等下一轮（乱删会把刚铺好的删光）
    if (!b.hasTable) continue;
    for (const row of liveRows(d, b.pluginId, b.slug)) {
      if (b.keepIds.has(row.chapter_id)) continue;
      d.prepare('UPDATE warm SET state = ?, updated_at = ? WHERE plugin_id = ? AND slug = ? AND chapter_id = ?').run(
        'dropped',
        now,
        b.pluginId,
        b.slug,
        row.chapter_id,
      );
      out.dropped++;
    }
  }

  /* ── 3. 到期了的删字节 ── */
  const due = d.prepare('SELECT * FROM warm WHERE purge_at IS NOT NULL AND purge_at <= ?').all(now);
  const dropped = d
    .prepare("SELECT * FROM warm WHERE state = 'dropped'")
    .all()
    .filter((row) => dueAtOf(d, row) <= now);
  const targets = new Map();
  for (const row of [...due, ...dropped]) targets.set(`${row.plugin_id}/${row.slug}/${row.chapter_id}`, row);
  if (!targets.size) return out;

  /*
   * 还要留着的那些地址。为什么扫全表而不是只扫这本书：一本书删掉的图可能正是
   * 另一本书的封面、或同一章重铺后新行也在用的 —— 删了就是白下第二遍。
   */
  const alive = new Set();
  const keepIds = new Set(targets.keys());
  for (const row of d.prepare('SELECT plugin_id, slug, chapter_id, images FROM warm').all()) {
    if (keepIds.has(`${row.plugin_id}/${row.slug}/${row.chapter_id}`)) continue;
    for (const url of JSON.parse(row.images)) alive.add(cacheKeyOf(url));
  }

  for (const row of targets.values()) {
    /*
     * 有人正在这章上（客户端在 RECENT_MS 内报过进度）—— 字节留着，行也留着，
     * 下一轮再判。这不违背保留窗口：留的是**正在被读**的那几章的字节。
     *
     * 但这道护栏只管**窗口淘汰**那一类。整本级的 purge_at 是用户自己下的决定
     * （取消追漫、移出书架），那时"正在读"不该把"删所有"拦下来 —— 何况人都翻完了，
     * 最后那一章的进度恰恰永远是最新的，不例外就是删不干净。
     */
    if (row.purge_at == null) {
      const active = d
        .prepare('SELECT 1 FROM positions WHERE plugin_id = ? AND slug = ? AND chapter_id = ? AND updated_at > ?')
        .get(row.plugin_id, row.slug, row.chapter_id, now - RECENT_MS);
      if (active) continue;
    }

    for (const url of JSON.parse(row.images)) {
      const key = cacheKeyOf(url);
      if (alive.has(key)) continue;
      const hit = entryOf(key);
      if (hit) out.freed += hit.bytes;
      if (await dropEntry(key)) out.files++;
    }
    d.prepare('DELETE FROM warm WHERE plugin_id = ? AND slug = ? AND chapter_id = ?').run(
      row.plugin_id,
      row.slug,
      row.chapter_id,
    );
  }
  return out;
}

/**
 * 一行该在什么时候被删。
 *
 * 读过的章按**读完那一刻** + 宽限期算，不是按台账上次被碰的时间 —— 后者会被
 * 每一轮的"续一下 updated_at"推着往后走，于是读完的章永远删不掉。
 * 掉出窗口的未读章没有"读完时刻"可依，才用台账时间。
 */
function dueAtOf(d, row) {
  if (row.purge_at != null) return row.purge_at;
  const pos = d
    .prepare('SELECT updated_at, percent FROM positions WHERE plugin_id = ? AND slug = ? AND chapter_id = ?')
    .get(row.plugin_id, row.slug, row.chapter_id);
  if (pos && pos.percent >= READ_AT) return pos.updated_at + READ_GRACE_MS;
  return row.updated_at + READ_GRACE_MS;
}
