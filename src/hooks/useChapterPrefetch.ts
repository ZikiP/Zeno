/**
 * 目录里的"猜你下一章"。
 *
 * 两种信号：
 *   - 明确意图：指针悬停 / 按下某一行 → 立刻取那一章（不受后台队列限制）；
 *   - 猜测：滚动停稳后取视口中央那一章 → 后台一次只跑一章，避免把服务端的
 *     渲染槽和上行带宽占满（正在读的那一章还在取图）。
 *
 * 只取地址表，不碰图片字节；点进去以后 useChapterLoader 直接命中 IndexedDB。
 * 同一章由 prefetchChapterTable 去重，和阅读器自己的请求共享同一个 Promise。
 */
import { useCallback, useEffect, useRef } from 'react';
import type { Plugin } from '@/site/types';
import { prefetchChapterTable, warmChapterStart } from '@/site/chapterPrefetch';

/** 滚动停多久算"停稳了"。短了会在快速滑动时一路取表，长了赶不上用户点击 */
const SETTLE_MS = 450;
/** 鼠标划过一行不算选中：停 300ms 才取。扫一遍列表不该发起十几次解析 */
const HOVER_MS = 300;

/** 视口里离中心最近的那一行（排除当前章 / 已读锚点） */
function nearestChapterId(root: ParentNode, skipId: string | null): string | null {
  const rows = root.querySelectorAll<HTMLElement>('[data-chapter-id]');
  if (!rows.length) return null;

  const box =
    root instanceof HTMLElement
      ? root.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };
  const mid = (box.top + box.bottom) / 2;

  let best: string | null = null;
  let bestDist = Infinity;
  for (const el of rows) {
    const r = el.getBoundingClientRect();
    /* 零高度 / 整行都在视口外的跳过：换章挂载那一帧的列表还没有尺寸 */
    if (r.height < 4 || r.bottom < box.top || r.top > box.bottom) continue;
    const id = el.dataset.chapterId;
    if (!id || id === skipId) continue;
    const d = Math.abs((r.top + r.bottom) / 2 - mid);
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
}

export function useChapterPrefetch(
  plugin: Plugin | null,
  slug: string,
  /** 当前章 / 上次读到的章：它已经在阅读器里或详情页的 idle 预热里，不用再猜 */
  skipId?: string | null,
) {
  const live = useRef(plugin);
  live.current = plugin;
  const skip = useRef<string | null>(skipId ?? null);
  skip.current = skipId ?? null;

  const timer = useRef<number | undefined>(undefined);
  const hoverTimer = useRef<number | undefined>(undefined);
  /** 后台正在跑的那一章；同一时刻只跑一章 */
  const busy = useRef(false);
  /** 这期间又滚到了别处：跑完手上的再接最新那个，不排队列 */
  const pending = useRef<string | null>(null);
  /** 上一次后台猜过的章，避免同一个位置反复滚动时重复取表 */
  const lastGuess = useRef<string | null>(null);

  const prefetch = useCallback(
    (chapterId: string) => {
      const p = live.current;
      if (!p || !chapterId || document.visibilityState !== 'visible') return;
      void prefetchChapterTable(p, slug, chapterId).then((images) => {
        if (images) warmChapterStart(images);
      });
    },
    [slug],
  );

  /** 悬停用：停 300ms 才算真的想看这一章；指针扫过去不触发解析 */
  const prefetchHover = useCallback(
    (chapterId: string) => {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = window.setTimeout(() => prefetch(chapterId), HOVER_MS);
    },
    [prefetch],
  );

  const runBackground = useCallback(
    (chapterId: string) => {
      const p = live.current;
      if (!p) return;
      if (busy.current) {
        pending.current = chapterId;
        return;
      }
      busy.current = true;
      void prefetchChapterTable(p, slug, chapterId)
        .then((images) => {
          /* 猜中的概率不低：第一张原图先拉，包子那种 1.6s 的 CDN 首包能省下来。
             只热一张 —— 猜错时浪费的上行要能忽略 */
          if (images) warmChapterStart(images, 1);
        })
        .finally(() => {
          busy.current = false;
          const next = pending.current;
          pending.current = null;
          if (next) runBackground(next);
        });
    },
    [slug],
  );

  /** 滚动/打开目录后叫它：停稳 450ms 再取视口中央那一章 */
  const prefetchNearest = useCallback(
    (root: ParentNode | null) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (!root || document.visibilityState !== 'visible') return;
        if (typeof navigator !== 'undefined' && !navigator.onLine) return;
        const id = nearestChapterId(root, skip.current);
        if (!id || id === lastGuess.current) return;
        lastGuess.current = id;
        runBackground(id);
      }, SETTLE_MS);
    },
    [runBackground],
  );

  /* 换书了：旧书的后台猜测和防抖都作废，别拿旧 slug 再取一章 */
  useEffect(() => {
    pending.current = null;
    lastGuess.current = null;
    window.clearTimeout(timer.current);
    window.clearTimeout(hoverTimer.current);
  }, [slug]);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(hoverTimer.current);
    },
    [],
  );

  return { prefetch, prefetchHover, prefetchNearest };
}
