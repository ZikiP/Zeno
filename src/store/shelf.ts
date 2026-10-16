import { db } from './db';
import { recordDelete } from './tombstones';
import { serverNow } from '@/sync/clock';
import type { ShelfEntry } from './types';

/** 书架与阅读进度 */

const shelfKey = (pluginId: string, slug: string) => `${pluginId}/${slug}`;

/** 读整个书架。传 pluginId 只看某个插件的 */
export async function getShelf(pluginId?: string): Promise<ShelfEntry[]> {
  const d = await db();
  /* 有 pluginId 就走索引，别把整表捞进内存再筛 */
  const all = pluginId
    ? ((await d.getAllFromIndex('shelf', 'pluginId', pluginId)) as ShelfEntry[])
    : ((await d.getAll('shelf')) as ShelfEntry[]);
  return all.sort((a, b) => b.addedAt - a.addedAt);
}

export async function isInShelf(pluginId: string, slug: string): Promise<boolean> {
  return !!(await (await db()).get('shelf', shelfKey(pluginId, slug)));
}

/**
 * 取单条书架记录（含进度）。
 *
 * 详情页要显示"上次读到哪"，光有 isInShelf 的布尔值不够 ——
 * 但也不该为此把整个书架捞进内存，所以单独给一个按主键的读法。
 */
export async function getShelfEntry(
  pluginId: string,
  slug: string,
): Promise<ShelfEntry | undefined> {
  return (await (await db()).get('shelf', shelfKey(pluginId, slug))) as ShelfEntry | undefined;
}

export async function addToShelf(
  pluginId: string,
  comic: { slug: string; title: string; cover: string },
): Promise<void> {
  const d = await db();
  const now = serverNow();
  /*
   * 新书插到最前：取现有最小 order 再减一。
   * 一本都没排过序时**不补编号** —— 那等于凭空把整架记录的 updatedAt 顶新，
   * 会把另一台设备上更新的标题/封面压掉。
   */
  const all = (await d.getAll('shelf')) as ShelfEntry[];
  const numbered = all.map((e) => e.order).filter((o): o is number => o !== undefined);
  await d.put('shelf', {
    key: shelfKey(pluginId, comic.slug),
    pluginId,
    slug: comic.slug,
    title: comic.title,
    cover: comic.cover,
    addedAt: now,
    updatedAt: now,
    positions: {},
    ...(numbered.length ? { order: Math.min(...numbered) - 1 } : {}),
  });
}

/**
 * 从书架移除。
 *
 * 这里不加 updatedAt —— 记录连同墓碑一起没了，下次重新入架时
 * addToShelf 会用「现在」重建 updatedAt，它必然比这条删除墓碑新，
 * 于是"删掉又重新加回"不会被别的设备上的旧墓碑再删一次。
 */
export async function removeFromShelf(pluginId: string, slug: string): Promise<void> {
  const key = shelfKey(pluginId, slug);
  const d = await db();
  await d.delete('shelf', key);
  // 不记墓碑的话，服务端那行还在，下次 pull 它就又回来了
  await recordDelete('shelf', key);
}

/**
 * 记录阅读进度。
 * 只在已入架的漫画上写 —— 没入架的读了也记不上，这是有意的：
 * 书架是用户显式的选择，进度跟着走。
 */
export async function savePosition(
  pluginId: string,
  slug: string,
  chapterId: string,
  pct: number,
): Promise<void> {
  const d = await db();
  const entry = await d.get('shelf', shelfKey(pluginId, slug));
  if (!entry) return;
  const now = serverNow();
  await d.put('shelf', {
    ...entry,
    lastChapterId: chapterId,
    // 时间戳必须落在记录上。之前同步时现算 Date.now()，
    // 于是每 5 分钟一轮同步就把所有进度都刷成"刚刚更新过"，
    // change_log 无意义地膨胀，LWW 也退化成"最近同步的那台赢"。
    positionsAt: { ...(entry.positionsAt ?? {}), [chapterId]: now },
    lastChapterAt: now,
    positions: { ...entry.positions, [chapterId]: pct },
  });
}

/**
 * 全书进度：读到第几章的第几页，摊到整本上。
 *
 * 之前书架那个环直接拿"最近一章读到几成"当进度，等于把本章进度条
 * 缩小了一圈摆在封面上 —— 一本 200 话读到第 12 话讲是 6%，环上却显示 42%。
 *
 * 位置用章节表里的下标，不用 chapter.index：上游的编号会跳号、
 * 也从 0 或 1 起算，只有排完序的下标是连续的。
 *
 * 返回 null 表示"算不出来"（有进度但章节表没缓存、或那一章已经不在表里）。
 * 这时候宁可不画环，也别画一个错数 —— 环上没有数字，错了也看不出来。
 *
 * 分母来自缓存的章节表，所以表要是不全（上游章节分页没抓完），
 * 比例会虚高。这是缓存本身决定的，不是这里能校验的 —— 记下以免日后
 * 看到"环怎么突然变成 100%"时往别处找。
 */
export function bookProgress(
  chapters: { id: string; index: number }[] | null | undefined,
  entry: Pick<ShelfEntry, 'lastChapterId' | 'positions'>,
): number | null {
  // 加了架还没读过，0% 是事实而不是算不出来
  if (!entry.lastChapterId) return 0;
  if (!chapters?.length) return null;
  const list = [...chapters].sort((a, b) => a.index - b.index);
  const at = list.findIndex((c) => c.id === entry.lastChapterId);
  if (at < 0) return null;
  const within = (entry.positions[entry.lastChapterId] ?? 0) / 100;
  return Math.min(100, Math.round(((at + within) / list.length) * 100));
}

/**
 * 读到这个百分比就算「看过了」。
 *
 * 留 5% 余量：最后一张图往往比屏幕矮，滚到底也到不了 100，
 * 卡在 97、98 的章应该算读完，而不是永远亮着。
 */
export const READ_AT = 95;

export const isRead = (pct: number | undefined): boolean => (pct ?? 0) >= READ_AT;

/**
 * 一键把某一章**之前**的章节标成已读 / 取消已读（追番补旧章用）。
 *
 * 一次读一次写：190 话的长篇要是逐章走 savePosition，就是三百多次
 * IndexedDB 往返，界面会明显卡一下。
 *
 * 「之前」按阅读顺序（index 升序）算 —— 跟列表此刻是正序还是倒序展示无关。
 *
 * 顺手把「上次读到」挪到这一章：用户点这个按钮表达的就是「我读到这了」，
 * 不跟着挪的话书架进度环还是几周前的数字，跟刚标完的列表自相矛盾。
 * 只往后挪不往前挪，免得把读到 150 话的人一键标前面的章打回 100 话。
 */
export async function markThrough(
  pluginId: string,
  slug: string,
  orderedIds: string[],
  uptoId: string,
  read: boolean,
): Promise<void> {
  const key = shelfKey(pluginId, slug);
  const d = await db();
  const entry = await d.get('shelf', key);
  if (!entry) return;
  const at = orderedIds.indexOf(uptoId);
  if (at <= 0) return; // 第一章之前什么都没有

  const now = serverNow();
  const positions = { ...entry.positions };
  const positionsAt = { ...entry.positionsAt };
  const cleared: string[] = [];
  for (const id of orderedIds.slice(0, at)) {
    if (read) {
      positions[id] = 100;
      positionsAt[id] = now;
    } else if (isRead(positions[id])) {
      /*
       * 取消已读只清「被标成已读」的那些。
       * 之前是无条件删 —— 于是一按取消，连某章读到 60% 的局部进度也一起没了：
       * 那是用户真的读出来的位置，不是这颗按钮写的。
       */
      delete positions[id];
      delete positionsAt[id];
      cleared.push(id);
    }
  }

  const curAt = entry.lastChapterId ? orderedIds.indexOf(entry.lastChapterId) : -1;
  const moveOn = read && at > curAt;

  await d.put('shelf', {
    ...entry,
    positions,
    positionsAt,
    lastChapterId: moveOn ? uptoId : entry.lastChapterId,
    lastChapterAt: moveOn ? now : entry.lastChapterAt,
    // 记录本身被动过，LWW 时钟要跟着走
    updatedAt: now,
  });

  /*
   * 取消已读删掉的行要逐个记墓碑 —— 跟 clearPosition 一个道理。
   * 不记的话服务端那些 100% 还活着：别的设备继续显示"已读"，
   * 本机哪天做一次全量拉取（since=0）就又全回来了，表现为"取消不掉"。
   */
  if (!read) {
    const base = shelfKey(pluginId, slug);
    for (const id of cleared) await recordDelete('position', `${base}/${id}`);
  }
}

/** 清掉某章的进度记录（读完之后没必要留着） */
export async function clearPosition(
  pluginId: string,
  slug: string,
  chapterId: string,
): Promise<void> {
  const d = await db();
  const entry = await d.get('shelf', shelfKey(pluginId, slug));
  if (!entry?.positions[chapterId]) return;
  const positions = { ...entry.positions };
  const positionsAt = { ...(entry.positionsAt ?? {}) };
  delete positions[chapterId];
  delete positionsAt[chapterId];
  await d.put('shelf', { ...entry, positions, positionsAt });
  await recordDelete('position', `${shelfKey(pluginId, slug)}/${chapterId}`);
}
