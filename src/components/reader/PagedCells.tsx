import { useCallback, useEffect, useRef, useState } from 'react';
import { PageImage } from './PageImage';
import { IconBookmark } from '@/components/Icons';
import type { PagePhase } from './PageStatus';

/**
 * 一屏里的几张图（单页一张、双页两张）。
 *
 * 从 PagedView 拆出来是因为翻页那套双缓冲状态机已经够长了，
 * 而"这一屏画什么"跟"什么时候换台面"是两件事。
 */
export function PagedCells({
  list,
  base,
  markedPages,
  enhance,
  onZoom,
  onScreenPhase,
  onScreenRetry,
}: {
  /** 这一屏的图片地址 */
  list: string[];
  /** 这一屏第一张在整个章节里的序号，用来算绝对页号 */
  base: number;
  markedPages: Set<number>;
  /** 画面增强（实验） */
  enhance?: boolean;
  onZoom: (src: string, index: number) => void;
  /**
   * 这一屏的汇总状态。提示画在整屏上而不是每张图里：
   * 分页的点击区盖在图片上面，图里的刷新按钮收不到点击。
   */
  onScreenPhase?: (phase: PagePhase) => void;
  /** 把「重试这一屏没画出来的页」交出去，给整屏的刷新按钮用 */
  onScreenRetry?: (retry: (() => void) | null) => void;
}) {
  const [phases, setPhases] = useState<PagePhase[]>([]);
  const retries = useRef(new Map<string, () => void>());

  const registerRetry = useCallback((src: string, retry: (() => void) | null) => {
    if (retry) retries.current.set(src, retry);
    else retries.current.delete(src);
  }, []);

  const retryAll = useCallback(() => {
    for (const retry of retries.current.values()) retry();
  }, []);

  useEffect(() => {
    if (!onScreenRetry) return;
    onScreenRetry(retryAll);
    return () => onScreenRetry(null);
  }, [onScreenRetry, retryAll]);

  const report = useCallback((i: number, p: PagePhase) => {
    setPhases((prev) => {
      if (prev[i] === p) return prev;
      const next = prev.slice();
      next[i] = p;
      return next;
    });
  }, []);

  /*
   * 只算这一屏真正有的那几张。
   * 换屏时不能在这里清零 —— 子组件的 effect 先跑、已经把新状态报上来了，
   * 父组件再清一次正好把刚到的状态抹掉（实测提示永远不出现）。
   */
  const live = phases.slice(0, list.length);
  /* 两张里只要有一张在等增强就报增强，否则有一张在拉图就报拉图 */
  const screenPhase: PagePhase = live.includes('enhance')
    ? 'enhance'
    : live.includes('load')
      ? 'load'
      : 'ok';

  useEffect(() => {
    onScreenPhase?.(screenPhase);
  }, [onScreenPhase, screenPhase]);

  return (
    <>
      {list.map((src, i) => {
        const abs = base + i;
        return (
          <div key={src} className="reader__cell">
            <PageImage
              src={src}
              alt={`第 ${abs + 1} 页`}
              enhance={enhance}
              /*
               * 这一张就是视口内容本身，必须 eager：lazy 的 <img> 刚挂上时
               * 浏览器可能推迟一帧才开始解码，而翻页动画正跑到一半。
               */
              eager
              fetchPriority="high"
              onDoubleClick={() => onZoom(src, abs)}
              onPhase={(p) => report(i, p)}
              onRetryReady={registerRetry}
            />
            {markedPages.has(abs) && (
              <span className="reader__bm-mark" title="已收藏">
                <IconBookmark size={13} filled />
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}
