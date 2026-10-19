/**
 * 预热的保留策略：每本只留「未读的最近 K 章」
 *
 * 为什么删得要有护栏：这些字节全可再生（翻到时现取就是），但删错一刀的代价是用户
 * 正好翻到那一张 —— 这一章于是又慢回去。三条护栏：
 *   1. 还被别的行引用的地址不删（两本书共用一张图，或同一章重铺过一次）
 *   2. 客户端最近报过进度的章不删（那就是正在读的那几章）
 *   3. 标成 dropped 之后先过一个宽限期再动刀（刚读完的那章不该立刻掉盘）
 *
 * 已读判定用的那个 95 是**故意的第二份**，跟 updates.mjs 抄一份 decodeEntities
 * 同一条路：服务端不该为了一个常数去引浏览器包。两边对不上的后果是刚读完的章
 * 被当成未读一直占盘，不会读坏任何东西。
 */
import { openDb } from './db.mjs';
import { cacheKeyOf, dropEntry, entryOf } from './cache-store.mjs';

/** 跟 src/store/shelf.ts 的 READ_AT 对齐：读到 95% 以上算读完 */
const READ_AT = 95;
/** 读完的章过了这一段时间才真删字节 */
const READ_GRACE_MS = Number(process.env.ZENO_WARM_READ_GRACE_MS || 7 * 24 * 3600_000);
/** 客户端在这时间内报过进度的章，字节不动刀 */
const RECENT_MS = Number(process.env.ZENO_WARM_RECENT_MS || 24 * 3600_000);
/** 铺失败（error）的章过了这么久重新排队：多半只是上游那一刻抽风 */
const RETRY_MS = Number(process.env.ZENO_WARM_RETRY_MS || 24 * 3600_000);

/** 这本书还在用的章，按客户端给的序号排；没序号的排在后面，照递交先后 */
function liveRows(d, pluginId, slug) {
  return d
    .prepare(
      `SELECT * FROM warm WHERE plugin_id = ? AND slug = ? AND state IN ('queued','running','done')
       ORDER BY CASE WHEN idx IS NULL THEN 1 ELSE 0 END, idx ASC, updated_at ASC`,
    )
    .all(pluginId, slug);
}

function readChapters(d, pluginId, slug) {
  return new Set(
    d
      .prepare('SELECT chapter_id FROM positions WHERE plugin_id = ? AND slug = ? AND percent >= ?')
      .all(pluginId, slug, READ_AT)
      .map((r) => r.chapter_id),
  );
}

/**
 * 此刻正在读的章：客户端在 RECENT_MS 之内报过进度。
 *
 * 为什么用进度而不是缓存条目的访问时间：那条路我试过并且坏了 —— 落盘的 putRow 是在
 * 响应流结束后**异步**提交的，它跟 warmed_at 谁先谁后是竞态，于是"刚铺完就该删"的
 * 那些有时被当成"正在读"永远删不掉。而 positions.updated_at 是客户端亲手写的时间，
 * 语义就是"人在这一章上"，不需要猜。
 */
function activeChapters(d, pluginId, slug, since) {
  return new Set(
    d
      .prepare('SELECT chapter_id FROM positions WHERE plugin_id = ? AND slug = ? AND updated_at > ?')
      .all(pluginId, slug, since)
      .map((r) => r.chapter_id),
  );
}

/**
 * 扫一遍。keep 由调用方给（warm.mjs 持有那份配置），这里不反向 import 它。
 *
 * 一轮只做两件事：把不该留的行标成 dropped，把过了宽限期的 dropped 行删干净。
 */
export async function sweepWarm(keep) {
  const d = openDb();
  const now = Date.now();
  const out = { dropped: 0, freed: 0, files: 0, requeued: 0 };

  out.requeued = d
    .prepare('UPDATE warm SET state = ?, updated_at = ? WHERE state = ? AND updated_at < ?')
    .run('queued', now, 'error', now - RETRY_MS).changes;

  for (const b of d.prepare('SELECT DISTINCT plugin_id, slug FROM warm').all()) {
    const rows = liveRows(d, b.plugin_id, b.slug);
    if (!rows.length) continue;
    const read = readChapters(d, b.plugin_id, b.slug);
    let unread = 0;
    for (const row of rows) {
      // 未读的最近 K 章留下；读完的、以及 K 之外的那些都标掉
      if (!read.has(row.chapter_id) && unread < keep) {
        unread++;
        continue;
      }
      d.prepare('UPDATE warm SET state = ?, updated_at = ? WHERE plugin_id = ? AND slug = ? AND chapter_id = ?').run(
        'dropped',
        now,
        row.plugin_id,
        row.slug,
        row.chapter_id,
      );
      out.dropped++;
    }
  }

  /*
   * 过了宽限期的 dropped 行才动刀。用 <= 是为了「宽限期 0 = 这一轮就删」真的成立：
   * 同一轮里 updated_at 拿的就是那个 now，严格小于会比不出来的。
   */
  const expired = d.prepare('SELECT * FROM warm WHERE state = ? AND updated_at <= ?').all('dropped', now - READ_GRACE_MS);
  if (!expired.length) return out;

  /*
   * 还要留着的那些地址。为什么扫全表而不是只扫这本书：一本书删掉的图可能正是
   * 另一本书的封面、或同一章重铺后新行也在用的 —— 删了就是白下第二遍。
   */
  const alive = new Set();
  for (const row of d.prepare('SELECT images FROM warm WHERE state <> ?').all('dropped')) {
    for (const url of JSON.parse(row.images)) alive.add(cacheKeyOf(url));
  }

  for (const row of expired) {
    /*
     * 有人正在这章上 —— 字节留着，行也留着，下一轮再判。
     * 这不违背"只留 K 章"：留的是**正在被读**的那几章的字节，台账本身仍然只对齐 K。
     */
    if (activeChapters(d, row.plugin_id, row.slug, now - RECENT_MS).has(row.chapter_id)) continue;
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
