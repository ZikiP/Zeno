import { db } from './db';
import type { ShelfEntry } from './types';

/** 书架与阅读进度 */

const shelfKey = (pluginId: string, slug: string) => `${pluginId}/${slug}`;

/** 读整个书架。传 pluginId 只看某个插件的 */
export async function getShelf(pluginId?: string): Promise<ShelfEntry[]> {
  const all = await (await db()).getAll('shelf');
  const filtered = pluginId ? all.filter((e) => e.pluginId === pluginId) : all;
  return filtered.sort((a, b) => b.addedAt - a.addedAt);
}

export async function isInShelf(pluginId: string, slug: string): Promise<boolean> {
  return !!(await (await db()).get('shelf', shelfKey(pluginId, slug)));
}

export async function addToShelf(
  pluginId: string,
  comic: { slug: string; title: string; cover: string },
): Promise<void> {
  await (await db()).put('shelf', {
    key: shelfKey(pluginId, comic.slug),
    pluginId,
    slug: comic.slug,
    title: comic.title,
    cover: comic.cover,
    addedAt: Date.now(),
    positions: {},
  });
}

export async function removeFromShelf(pluginId: string, slug: string): Promise<void> {
  await (await db()).delete('shelf', shelfKey(pluginId, slug));
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
  await d.put('shelf', {
    ...entry,
    lastChapterId: chapterId,
    positions: { ...entry.positions, [chapterId]: pct },
  });
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
  delete positions[chapterId];
  await d.put('shelf', { ...entry, positions });
}
