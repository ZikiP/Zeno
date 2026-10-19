/**
 * 把追漫的台账补齐到「该有那些章」
 *
 * 这是"没人开页面也照追"的那一半：服务端手上已经有足够信息自己算出该铺哪些章 ——
 *   书架（在不在架）+ book_prefs.warm（这本追不追）+ updates.chapter_ids
 *   （有哪些章、什么顺序，追更循环顺手存下来的）+ positions（读到哪了）。
 * 缺的那几章的地址表由 warm-resolve 现解，解出来才进台账排队下载。
 *
 * 为什么每一轮都重算而不是"新章出来时补一次"：这几张表各自被不同设备写，
 * 谁先谁后没有保证 —— 追更那一轮可能比客户端的进度同步早跑，也可能晚。
 * 每轮对齐一次，晚到的那份下一轮就补上，不需要谁通知谁。
 */
import { openDb } from './db.mjs';
import { installedPlugins } from './plugins.mjs';
import { renderLoad } from './render.mjs';
import { READ_AT, keepChapters, markUnresolved, noteRow, upsertQueued, warmIds } from './warm-store.mjs';
import { resolveChapter } from './warm-resolve.mjs';

/** 一轮最多解几章的地址表。解一章至少一次上游往返，browser 模式的站还要占渲染槽 */
const RESOLVE_PER_ROUND = Math.max(1, Number(process.env.ZENO_WARM_RESOLVE_PER_ROUND || 6));
/** 书与书之间歇一下，别一次把某一轮的额度全花在一本上 */
const BOOK_GAP_MS = Number(process.env.ZENO_WARM_BOOK_GAP_MS || 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 开了追漫、且在架的书，各自"该铺的章"是哪几章。
 *
 * 顺序照 chapter_ids（listChapters 末尾按 index 升序排过，那就是阅读顺序），
 * 已读的整段跳过 —— 已读章的字节走的是另一条到期路（读过 3 天后腾盘）。
 */
export function followedBooks() {
  const d = openDb();
  const out = [];
  for (const s of d.prepare('SELECT plugin_id, slug FROM shelf').all()) {
    const pref = d.prepare('SELECT data FROM book_prefs WHERE plugin_id = ? AND slug = ?').get(s.plugin_id, s.slug);
    let warm = false;
    try {
      warm = JSON.parse(pref?.data ?? '{}')?.warm === true;
    } catch {
      continue; // 坏的那条当没记过，别让它把整轮带停
    }
    if (!warm) continue;

    const upd = d.prepare('SELECT chapter_ids FROM updates WHERE key = ?').get(`${s.plugin_id}/${s.slug}`);
    let chapters = [];
    try {
      chapters = JSON.parse(upd?.chapter_ids ?? '[]');
    } catch {
      chapters = [];
    }
    const read = new Set(
      d
        .prepare('SELECT chapter_id FROM positions WHERE plugin_id = ? AND slug = ? AND percent >= ?')
        .all(s.plugin_id, s.slug, READ_AT)
        .map((r) => r.chapter_id),
    );
    out.push({
      pluginId: s.plugin_id,
      slug: s.slug,
      // 没数过章节表的书这轮跳过：追更循环还没跑到它，下一轮就有了
      unread: chapters.filter((c) => c?.id && !read.has(c.id)),
      have: warmIds(s.plugin_id, s.slug),
    });
  }
  return out;
}

/**
 * 补齐一轮。返回 { resolved, queued, failed, skipped }。
 *
 * browser 模式的站在渲染槽满的时候这一轮直接跳过 —— 那是用户正在翻别的章，
 * 追漫不该把他挤出去。fetch 模式的站不占槽，照解。
 */
export async function reconcileLedger() {
  const keep = keepChapters();
  const byId = new Map(installedPlugins().map((p) => [p.meta?.id, p]));
  const summary = { resolved: 0, queued: 0, failed: 0, skipped: 0 };
  let budget = RESOLVE_PER_ROUND;

  for (const book of followedBooks()) {
    if (budget <= 0) break;
    const plugin = byId.get(book.pluginId);
    if (!plugin) {
      summary.skipped++; // 源被卸了。台账留着，等它装回来
      continue;
    }
    const targets = book.unread.filter((c) => !book.have.has(c.id)).slice(0, Math.min(keep, budget));
    for (const c of targets) {
      if (budget <= 0) break;
      budget--;
      if (renderLoad().openPages >= renderLoad().max) {
        summary.skipped++;
        break; // 渲染槽被用户占着，这本下一轮再说
      }
      try {
        const { images, partial } = await resolveChapter(plugin, book.slug, c.id);
        upsertQueued(book.pluginId, book.slug, c.id, c.index, images);
        summary.resolved++;
        summary.queued++;
        // 铺是铺了、但不全：只留一句备注。别去擦这一行，那等于把下好的图也判没了
        if (partial) noteRow(book.pluginId, book.slug, c.id, '只解出部分内页');
      } catch (e) {
        // 留一行 error：不然下一轮又去解同一章，白敲站点
        markUnresolved(book.pluginId, book.slug, c.id, c.index, e?.message ?? e);
        summary.failed++;
      }
      await sleep(BOOK_GAP_MS);
    }
  }
  return summary;
}
