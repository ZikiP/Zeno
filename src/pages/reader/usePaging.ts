import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReaderPrefs } from '@/reader/prefs';

export type ReaderMode = 'scroll' | 'paged';

/**
 * 一屏几张。
 *
 * 「双页」是**翻页**这一档的选项：它决定一次手势抬走几张图。滚动模式没有"屏"，
 * 几十页从上往下一张一张排着，所以那里永远是 1。
 *
 * 别小看这一条：以前它不分模式，于是"滚动 + 双页"这个组合让下游三处都以为
 * 一屏两张 —— 其中最疼的是下一章预热的目标宽度按半个视口算（见 usePrefetch.ts），
 * 缓存键跟实际显示宽度对不上，翻过去那一帧拿不到增强版，只能先画原图再硬换，
 * 正是被报上来的那一下闪。
 */
export function perPageFor(mode: ReaderMode, pageMode: ReaderPrefs['pageMode']): number {
  return mode === 'paged' && pageMode === 'double' ? 2 : 1;
}

/** 那一屏占多宽、这台设备几个物理像素对一个 CSS 像素 */
export interface Viewport {
  innerWidth: number;
  devicePixelRatio: number;
}

/**
 * 某一档下"一屏"在屏幕上占多宽（设备像素）。
 *
 * 给还没挂载的那一屏用：预热下一章时量不到 offsetWidth，而增强版是按显示宽度做的 ——
 * 算错宽度等于算了一张用不上的图，缓存键也对不上。分页双屏占一半，
 * 单屏和滚动的"适应宽度"都是整个视口宽。
 *
 * 摆在这儿、并且把 viewport 收成参数，是为了能被测试钉住（test-paging.ts）：
 * 这个数算错既不报错也不变慢，表现只是"翻到下一章时闪一下"，最难查。
 */
export function warmTargetWidth(perPage: number, vp: Viewport): number {
  return Math.round((vp.innerWidth / (perPage > 1 ? 2 : 1)) * (vp.devicePixelRatio || 1));
}

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
  /** 一屏几张。滚动模式永远是 1（见 perPageFor） */
  perPage: number;
  /** 分页模式总屏数。滚动模式下等于图片张数，但那一档的页码不读它 */
  totalPages: number;
  /** 当前屏第一张在整个章节里的序号。滚动模式就是当前那张 */
  startIndex: number;
  /** 当前页对应的图片序号（双页时取第一张） */
  currentImageIndex: number;
  /** 底部进度条该画到哪儿。两种模式单位不同，各自换算 */
  progressPercent: number;

  setPage: (n: number) => void;
  /** 语义化的前进 / 后退，RTL 差异在调用方处理 */
  goForward: () => void;
  goBack: () => void;
  /** 点左右两侧翻页。RTL 下语义会翻转 */
  tap: (side: 'left' | 'right', isRTL: boolean) => void;
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
  /**
   * 已经在最后一屏还要再往前翻。自动下一章的入口挂这儿。
   *
   * 为什么放在这一层：往前翻的动作有四个来源（点右区、点左区在 RTL 下、
   * 滑动、键盘），它们全都汇到 turnTo。在界面上各接一遍迟早会漏一个 ——
   * 漏掉的那个就是"别的方式都能跳章，键盘不行"。
   */
  onForwardAtEnd?: () => void,
): Paging {
  const [page, setPage] = useState(0);

  const perPage = perPageFor(mode, pageMode);
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
      if (clamped === pageRef.current) {
        /*
         * 已经在最后一屏还要再往前 —— 以前这里静默不动，
         * 于是"翻到底"这件事只剩那颗胶囊一个入口。交给调用方去接下一章。
         * 只在**往前**且真在末页时算，往回翻到第一页之外还是老样子（不动）。
         */
        if (onForwardAtEnd && next > clamped && pageRef.current >= totalPages - 1) onForwardAtEnd();
        return;
      }
      pageRef.current = clamped;
      setPage(clamped);
      if (record && mode === 'paged' && totalPages > 1) record(clamped / (totalPages - 1));
    },
    [totalPages, record, mode, onForwardAtEnd],
  );

  const goForward = useCallback(() => {
    turnTo(pageRef.current + 1);
  }, [turnTo]);

  const goBack = useCallback(() => {
    turnTo(pageRef.current - 1);
  }, [turnTo]);

  /**
   * 点两侧翻页。
   *
   * RTL：点左前进、点右后退（日漫习惯）。中间 36% 不归这里管 ——
   * 它不翻页，只开关悬浮件，由页面直接接走。
   */
  const tap = useCallback(
    (side: 'left' | 'right', isRTL: boolean) => {
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
    // 分页是「第几屏 / 共几屏」，滚动是「第几张 / 共几张」，两种各自成立
    progressPercent:
      mode === 'paged'
        ? ((page + 1) / Math.max(1, totalPages)) * 100
        : totalImages > 0
          ? (page / totalImages) * 100
          : 0,
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
