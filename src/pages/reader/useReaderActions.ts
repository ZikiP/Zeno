import { useCallback, useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Bookmark } from '@/store/db';
import type { Plugin } from '@/site/types';
import type { ReaderPrefs } from '@/reader/prefs';
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
  patchPrefs: (patch: Partial<ReaderPrefs>) => void | Promise<void>;
}

export function useReaderActions(a: Args) {
  /** 进度条跳转后面跟着的那个"等高度稳定"的轮询句柄 */
  const settler = useRef<number>(0);

  /**
   * 换章。
   *
   * 不用带 p/n：阅读器会按缓存的章节表重新算前后关系，
   * 带着旧的过去反而会指错章（换了章之后前后各挪一格）。
   */
  /*
   * 换章用 replace，不 push。
   *
   * 每翻一章就往历史里塞一条的话，读三十章出来要点三十次返回 —— 而"返回"在
   * 阅读器里的意思从来不是"上一章"（那是左右翻页/滑动干的事），是"我读完了，出去"。
   * 自动接下一章更明显：那是在没人操作的情况下一路往里堆。
   *
   * 从详情页点进来那一条 push 保留着，所以退一次就回到详情页。
   */
  const gotoChapter = useCallback(
    (id: string) => {
      if (!a.plugin?.meta.id) return;
      a.nav(`/read/${a.plugin.meta.id}/${a.slug}/${id}`, { replace: true });
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

  /**
   * 滚动模式下点进度条跳到整章的某个位置。
   *
   * 按**滚动距离**换算，而不是"跳到第几张图"：存下来的进度本来就是
   * `scrollTop / 可滚距离`（见 useChapterLoader 的 onScroll），所以点 30%
   * 落的位置和"上次读到 30%"恢复出来的位置必须是同一个地方 —— 用图片序号
   * 去凑就会差半张图。
   *
   * 图片是 lazy 的：跳的那一刻 scrollHeight 只算得出已经挂上的那部分，
   * 上面那些图陆续加载完之前高度还在长，一次算死的 scrollTop 会漂。
   * 所以照恢复那条路一样盯一小会儿，高度一变就按同一个比例重算。
   */
  const seekScroll = useCallback(
    (ratio: number) => {
      const el = a.scrollRef.current;
      if (!el) return;
      const target = Math.max(0, Math.min(1, ratio));
      if (settler.current) window.clearInterval(settler.current);

      let last = -1;
      let steady = 0;
      const apply = () => {
        const scrollable = el.scrollHeight - el.clientHeight;
        if (scrollable > 0) el.scrollTop = scrollable * target;
      };
      const stop = () => {
        if (settler.current) window.clearInterval(settler.current);
        settler.current = 0;
        window.clearTimeout(cap);
      };
      apply();
      const poll = window.setInterval(() => {
        const h = el.scrollHeight;
        if (h !== last) {
          last = h;
          steady = 0;
          return apply();
        }
        // 连续三拍（600ms）没再长，就当该到的图都到了
        if (++steady >= 3) stop();
      }, 200);
      // 别为了一张永远加载不出来的图一直轮询
      const cap = window.setTimeout(stop, 4000);
      settler.current = poll;
    },
    [a.scrollRef],
  );

  /** 换组件、离开阅读器都要停掉那个轮询，不然它还在偷偷改 scrollTop */
  useEffect(() => () => {
    if (settler.current) window.clearInterval(settler.current);
  }, []);

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
   * 写进这本书的偏好（bookPrefs 本来就是一本书一行、参与同步），
   * 顺带更新全局默认值 —— 和图片适配、方向那些显示项走同一条路。
   * 同时把页码归零，否则会带着另一套模式的偏移插进一个不存在的屏。
   */
  const switchMode = useCallback(
    (m: ReaderMode) => {
      void a.patchPrefs({ mode: m });
      a.paging.setPage(0);
    },
    [a.patchPrefs, a.paging],
  );

  return { gotoChapter, scrollToPage, seekScroll, toggleMark, jumpToBookmark, switchMode };
}
