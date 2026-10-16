import { db } from './db';
import { recordDelete } from './tombstones';
import type { Bookmark } from './db';
import { serverNow } from '@/sync/clock';

/** 书签与笔记 */

const bmKey = (pluginId: string, slug: string, cid: string, page: number) =>
  `${pluginId}/${slug}/${cid}/${page}`;

export async function getBookmarks(pluginId: string, slug?: string): Promise<Bookmark[]> {
  const d = await db();
  /*
   * 走 pluginId 索引，别全表捞进内存再筛。
   * 空 pluginId 是「取全部」的调用约定（transfer.ts 同步时就这么传），
   * 那种情况下索引查不到东西，必须回全表。
   */
  const all = pluginId
    ? ((await d.getAllFromIndex('bookmarks', 'pluginId', pluginId)) as Bookmark[])
    : ((await d.getAll('bookmarks')) as Bookmark[]);
  const filtered = slug ? all.filter((b) => b.slug === slug) : all;
  return filtered.sort((a, b) => b.createdAt - a.createdAt);
}

/** 加书签。已存在同位置则保留原创建时间 */
export async function addBookmark(
  b: Omit<Bookmark, 'key' | 'createdAt'> & { key?: string },
): Promise<string> {
  const d = await db();
  const key = b.key ?? bmKey(b.pluginId, b.slug, b.chapterId, b.page);
  const existing = await d.get('bookmarks', key);
  await d.put('bookmarks', {
    ...b,
    key,
    createdAt: existing?.createdAt ?? Date.now(),
    // 覆盖旧值时 updatedAt 要前进，否则同步那边永远认为没变过
    updatedAt: serverNow(),
  });
  return key;
}

export async function updateBookmarkNote(key: string, note: string): Promise<void> {
  const d = await db();
  const bm = await d.get('bookmarks', key);
  if (!bm) return;
  await d.put('bookmarks', { ...bm, note, updatedAt: serverNow() });
}

export async function removeBookmark(key: string): Promise<void> {
  const d = await db();
  await d.delete('bookmarks', key);
  await recordDelete('bookmark', key);
}

/** 找某一页的书签。切换书签状态时用 */
export async function findBookmark(
  pluginId: string,
  slug: string,
  chapterId: string,
  page: number,
): Promise<Bookmark | undefined> {
  return (await db()).get('bookmarks', bmKey(pluginId, slug, chapterId, page));
}

/** 把书签按章节归类，给阅读器的目录用 */
export async function getBookmarksByChapter(
  pluginId: string,
): Promise<Map<string, number[]>> {
  const all = await getBookmarks(pluginId);
  const map = new Map<string, number[]>();
  for (const b of all) {
    const arr = map.get(b.chapterId) ?? [];
    arr.push(b.page);
    map.set(b.chapterId, arr);
  }
  return map;
}
