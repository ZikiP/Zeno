import { db } from './db';
import { recordDelete } from './tombstones';
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
  const now = Date.now();
  await d.put('shelf', {
    key: shelfKey(pluginId, comic.slug),
    pluginId,
    slug: comic.slug,
    title: comic.title,
    cover: comic.cover,
    addedAt: now,
    updatedAt: now,
    positions: {},
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
  const now = Date.now();
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
