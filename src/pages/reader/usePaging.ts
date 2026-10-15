import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReaderPrefs } from '@/reader/prefs';

export type ReaderMode = 'scroll' | 'paged';

/**
 * 翻页状态机
 *
 * 管住「当前在第几页」「怎么翻」「点屏幕各处做什么」，
 * 以及滚动模式下的进度上报与工具栏显隐。
 *
 * 抽出来的原因：这些逻辑有明确的输入输出和状态转换，
 * 混在页面里会让页面同时关心数据和交互，两边都难读。
 */
export interface Paging {
  /** 分页模式下：屏序号。滚动模式下：估算的图片序号 */
  page: number;
  /** 分页模式下每屏几张 */
  perPage: number;
  /** 分页模式总屏数 */
  totalPages: number;
  /** 当前屏第一张在整个章节里的序号 */
  startIndex: number;
  /** 当前页对应的图片序号（双页时取第一张） */
  currentImageIndex: number;

  setPage: (n: number) => void;
  /** 语义化的前进 / 后退，RTL 差异在调用方处理 */
  goForward: () => void;
  goBack: () => void;
  /** 点击左右区域。RTL 下语义会翻转 */
  tap: (side: 'left' | 'right' | 'center', isRTL: boolean) => void;
  /** 点进度条。ratio 为 0-1 */
  seek: (ratio: number) => void;

  /** 滚动事件处理，返回是否改变了页码（用来决定要不要记录） */
  onScroll: (el: HTMLElement, totalImages: number, record: (ratio: number) => void) => void;
}

export function usePaging(
  totalImages: number,
  mode: ReaderMode,
  pageMode: ReaderPrefs['pageMode'],
  /**
   * 翻页模式下的进度上报。
   *
   * 传进来才记。以前只有滚动视图的 onScroll 会记，于是用分页读的书
   * 从来没写过 positions —— 书架的进度环和详情页的「继续阅读」
   * 对分页读者是空的。
   */
  record?: (ratio: number) => void,
): Paging {
  const [page, setPage] = useState(0);

  const perPage = pageMode === 'double' ? 2 : 1;
  const totalPages = totalImages > 0 ? Math.ceil(totalImages / perPage) : 0;
  const startIndex = page * perPage;

  /*
   * 页码的同步副本。连点/快滑时同一帧内会触发多次，
   * 只读已渲染的 page 的话第二次算出同一个目标、setPage 被 React 跳过，
   * 就少翻了一页。
   */
  const pageRef = useRef(page);
  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  /**
   * 翻到第 next 屏，并把它记成进度。
   *
   * 只有走这里的翻页才上报；setPage 留给程序定位（恢复上次读到的位置、
   * 切模式时归零）—— 那条路也上报的话，一切换模式就把 0% 盖回真进度上。
   *
   * 比例取 next/(totalPages-1)：首屏 0、末屏 1，和滚动的
   * scrollTop/可滚距离同构，所以恢复时 round 回去正好落回同一屏。
   */
  const turnTo = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(totalPages - 1, next));
      if (clamped === pageRef.current) return;
      pageRef.current = clamped;
      setPage(clamped);
      if (record && mode === 'paged' && totalPages > 1) record(clamped / (totalPages - 1));
    },
    [totalPages, record, mode],
  );

  const goForward = useCallback(() => {
    turnTo(pageRef.current + 1);
  }, [turnTo]);

  const goBack = useCallback(() => {
    turnTo(pageRef.current - 1);
  }, [turnTo]);

  /**
   * 点击区域。
   *
   * RTL：点左前进、点右后退（日漫习惯）。中间 36% 只切工具栏，
   * 那段留这么宽是为了避免「想看工具栏却翻页了」这种误触。
   */
  const tap = useCallback(
    (side: 'left' | 'right' | 'center', isRTL: boolean) => {
      if (side === 'center') return;
      const forward = isRTL ? side === 'left' : side === 'right';
      if (forward) goForward();
      else goBack();
    },
    [goForward, goBack],
  );

  const seek = useCallback(
    (ratio: number) => {
      turnTo(Math.floor(ratio * totalPages));
    },
    [totalPages, turnTo],
  );

  /**
   * 滚动处理。
   *
   * 页码不能按 clientWidth 算 —— 那只在等宽布局下成立。
   * 一话里图片尺寸混着来时（比如 1200×3436 和 1300×2521）会完全乱跳。
   *
   * 滚动模式下 page 就是图片序号，必须落在 0..total-1：
   * 之前写成 Math.min(total, floor(ratio*total)+1)，顶部时算出 1（显示成"2"，
   * off-by-one），滚到底算出 total（越界）—— 标题变成 "total+1 / total"，
   * 而 useBookmarks 用 images[page] 取缩略图会拿到 undefined。
   */
  const onScroll = useCallback(
    (el: HTMLElement, total: number, record: (ratio: number) => void) => {
      const scrollable = el.scrollHeight - el.clientHeight;
      if (scrollable <= 0) return;

      const ratio = el.scrollTop / scrollable;
      record(ratio);

      if (total > 0) {
        const next = Math.min(total - 1, Math.floor(ratio * total));
        setPage((prev) => (prev === next ? prev : next));
      }
    },
    [],
  );

  return {
    page,
    perPage,
    totalPages,
    startIndex,
    currentImageIndex: mode === 'paged' ? startIndex : page,
    setPage,
    goForward,
    goBack,
    tap,
    seek,
    onScroll,
  };
}

/** 工具栏显隐：向下滚隐藏、向上滚显示 */
export function useToolbarVisibility() {
  const [visible, setVisible] = useState(true);

  const onScroll = useCallback((el: HTMLElement) => {
    const prevTop = Number(el.dataset.top ?? el.scrollTop);
    el.dataset.top = String(el.scrollTop);
    if (Math.abs(el.scrollTop - prevTop) < 4) return;
    setVisible(el.scrollTop < prevTop || el.scrollTop < 80);
  }, []);

  const toggle = useCallback(() => setVisible((v) => !v), []);

  return { visible, setVisible, onScroll, toggle };
}
