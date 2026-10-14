import { useCallback } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Bookmark } from '@/store/db';
import type { Plugin } from '@/site/types';
import type { Bookmarks } from './useBookmarks';
import type { Paging, ReaderMode } from './usePaging';

/**
 * 阅读器的动作
 *
 * 从 ReaderPage 抽出来：那 50 行不是「谁依赖谁」的编排，
 * 而是「跳到某一页 / 收藏本页 / 换章 / 换模式」的具体做法。
 * 抽走之后页面只剩接线，改动动作时不用在界面 JSX 里找。
 */
interface Args {
  plugin: Plugin | null;
  slug: string;
  chapterId: string;
  images: string[] | null;
  mode: ReaderMode;
  paging: Paging;
  bookmarks: Bookmarks;
  scrollRef: React.RefObject<HTMLDivElement>;
  nav: NavigateFunction;
  flash: (text: string) => void;
  setMode: (m: ReaderMode) => void;
}

export function useReaderActions(a: Args) {
  /**
   * 换章。
   *
   * 不带 p/n：换了章就不知道新的前后关系了，带着旧的过去会指错章。
   * 前后章由详情页写在 URL 查询参数里，所以只有详情页跳进来时才可能有。
   */
  const gotoChapter = useCallback(
    (id: string) => {
      if (!a.plugin?.meta.id) return;
      a.nav(`/read/${a.plugin.meta.id}/${a.slug}/${id}`);
    },
    [a.nav, a.plugin?.meta.id, a.slug],
  );

  /** 定位到第 p 张图。分页模式换算成"第几屏"，滚动模式直接滚到那个元素 */
  const scrollToPage = useCallback(
    (p: number) => {
      if (a.mode === 'paged') {
        a.paging.setPage(Math.floor(p / a.paging.perPage));
        return;
      }
      const el = a.scrollRef.current;
      const target = el?.querySelectorAll('.reader__page')[p] as HTMLElement | undefined;
      if (el && target) el.scrollTop = target.offsetTop - 8;
    },
    [a.mode, a.paging, a.scrollRef],
  );

  const toggleMark = useCallback(async () => {
    if (!a.images) return;
    const added = await a.bookmarks.toggle(a.paging.currentImageIndex, {
      plugin: a.plugin,
      slug: a.slug,
      chapterId: a.chapterId,
      images: a.images,
    });
    a.flash(added ? '已收藏本页' : '已删除书签');
  }, [a.images, a.bookmarks, a.paging.currentImageIndex, a.plugin, a.slug, a.chapterId, a.flash]);

  /** 从书签列表跳过去。别的章的书签要先换章 */
  const jumpToBookmark = useCallback(
    (b: Bookmark) => {
      if (b.slug !== a.slug || b.chapterId !== a.chapterId) {
        a.nav(`/read/${a.plugin?.meta.id ?? ''}/${a.slug}/${b.chapterId}`);
        return;
      }
      scrollToPage(b.page);
      a.flash(`跳到第 ${b.page + 1} 页`);
    },
    [a.slug, a.chapterId, a.plugin?.meta.id, a.nav, scrollToPage, a.flash],
  );

  /**
   * 切滚动 / 分页。
   *
   * 模式要落 localStorage —— 它是"这台设备的阅读习惯"，不该每章重新问一遍；
   * 同时把页码归零，否则分页模式下会带着滚动模式的偏移插进一个不存在的屏。
   */
  const switchMode = useCallback(
    (m: ReaderMode) => {
      a.setMode(m);
      localStorage.setItem('readerMode', m);
      a.paging.setPage(0);
    },
    [a.setMode, a.paging],
  );

  return { gotoChapter, scrollToPage, toggleMark, jumpToBookmark, switchMode };
}
