import { useCallback, useEffect, useState } from 'react';
import { addBookmark, findBookmark, getBookmarks, removeBookmark } from '@/store/bookmarks';
import type { Plugin } from '@/site/types';

/**
 * 书签
 *
 * 管三件事：读出标记、加/删书签、按页码定位。
 * 笔记编辑交给 BookmarkPanel 自己处理，这里不碰。
 */
export interface Bookmarks {
  /** 本章有书签的页码集合 */
  markedPages: Set<number>;
  /** 全部书签按 chapterId 归类，给章节目录用 */
  byChapter: Map<string, number[]>;
  /** 返回切换后的状态（true = 已加，false = 已删），方便上层弹提示 */
  toggle: (page: number, context: MarkContext) => Promise<boolean>;
  /** 重新从存储读取 */
  refresh: () => Promise<void>;
}

/** 加书签时需要的上下文 */
export interface MarkContext {
  plugin: Plugin | null;
  slug: string;
  chapterId: string;
  /** 整章图片，用于取缩略图和算百分比 */
  images: string[];
}

export function useBookmarks(
  plugin: Plugin | null,
  chapterId: string,
): Bookmarks {
  const [markedPages, setMarkedPages] = useState<Set<number>>(new Set());
  const [byChapter, setByChapter] = useState<Map<string, number[]>>(new Map());

  const pluginId = plugin?.meta.id;

  const refresh = useCallback(async () => {
    if (!pluginId) return;
    const all = await getBookmarks(pluginId);

    const map = new Map<string, number[]>();
    for (const b of all) {
      const arr = map.get(b.chapterId) ?? [];
      arr.push(b.page);
      map.set(b.chapterId, arr);
    }
    setByChapter(map);
    setMarkedPages(new Set(map.get(chapterId) ?? []));
  }, [pluginId, chapterId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 返回操作后的状态：true = 已加书签，false = 已删 */
  const toggle = useCallback(
    async (page: number, mark: MarkContext): Promise<boolean> => {
      if (!mark.plugin || !mark.images.length) return false;
      const pid = mark.plugin.meta.id;

      // 只查这一页，不用拉全量书签列表
      const existing = await findBookmark(pid, mark.slug, mark.chapterId, page);

      if (existing) {
        await removeBookmark(existing.key);
        await refresh();
        return false;
      }

      await addBookmark({
        pluginId: pid,
        slug: mark.slug,
        chapterId: mark.chapterId,
        page,
        percent: Math.round((page / mark.images.length) * 100),
        thumb: mark.images[page],
      });
      await refresh();
      return true;
    },
    [refresh],
  );

  return { markedPages, byChapter, toggle, refresh };
}
