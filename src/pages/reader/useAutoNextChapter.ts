import { useCallback, useEffect, useRef } from 'react';
import { isImageReady, onImageStateChange } from '@/components/RetryableImage';

/**
 * 读到底自动接下一章
 *
 * 只在"真的到底"那一刻跳，两种模式各有一条路：
 *  - 滚动：滚到底（离底部 48px 以内）。留这一点是因为移动端有回弹（overscroll），
 *    压到 0 反而永远等不到那一下；也顺手把"手指还差一点点"这种收尾算进去。
 *  - 分页：在最后一页**再往前翻一次**。这是用户主动的动作，不是误触 ——
 *    所以它不该被那颗「下一章」胶囊挡住去路，胶囊本身继续留着
 *    （它还要负责"已是最后一章"这句话）。
 *
 * 为什么必须等最后一张图落地：滚动模式下图片是 lazy 的，最后一张还没加载时
 * 它那块高度是算不准的，此刻的"底部"不是真底部 —— 直接跳就会把这一章的尾巴
 * 翻过去，而且人已经在新章开头，很难发现漏了。所以条件是两个：**在底部 且
 * 最后一张已经能画**。少后者的话，某些章节会永远不跳（一直停在底部等），
 * 所以再订阅一次图片状态：图落地时重新判一遍，不用人再动一下手指。
 *
 * 一章只跳一次（fired）。没有这道闩，跳过去之后短章节一挂上就是"底部"，
 * 会连着跳两三章 —— 那种体验比没有这功能糟得多。
 */
const BOTTOM_PX = 48;

export function useAutoNextChapter(a: {
  enabled: boolean;
  nextId: string | null;
  images: string[] | null;
  onGo: (chapterId: string) => void;
}) {
  /** 最新那份参数。回调要读到当前章、当前开关，不能抱着第一次渲染的闭包不放 */
  const live = useRef(a);
  useEffect(() => {
    live.current = a;
  });

  const fired = useRef(false);
  useEffect(() => {
    fired.current = false;
  }, [a.nextId, a.images]);

  /** 滚动容器。图片落地那次重判要知道"还在底部吗"，得留着它 */
  const scrollEl = useRef<HTMLElement | null>(null);
  const atBottom = useRef(false);

  const tryGo = useCallback(() => {
    const cur = live.current;
    if (!cur.enabled || !cur.nextId || fired.current) return;
    const last = cur.images?.[cur.images.length - 1];
    if (last && !isImageReady(last)) return;
    fired.current = true;
    scrollEl.current = null;
    atBottom.current = false;
    cur.onGo(cur.nextId);
  }, []);

  const onScroll = useCallback((el: HTMLElement) => {
    scrollEl.current = el;
    const scrollable = el.scrollHeight - el.clientHeight;
    /*
     * scrollable <= 0 直接不算到底：一屏就放得下的章节根本没有"读到底"这回事，
     * 挂在这儿的话它会自己一路跳下去。
     */
    if (scrollable <= 0) {
      atBottom.current = false;
      return;
    }
    atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_PX;
    if (atBottom.current) tryGo();
  }, [tryGo]);

  useEffect(() => {
    if (!a.enabled || !a.nextId) return;
    // 最后一张终于落地 → 如果人还停在底部，这会儿补跳
    return onImageStateChange(() => {
      const el = scrollEl.current;
      if (!atBottom.current || !el) return;
      const scrollable = el.scrollHeight - el.clientHeight;
      if (scrollable <= 0) return;
      // 图落地把页高撑开了，人其实被留在了半路 —— 那就不算到底
      if (el.scrollTop + el.clientHeight < el.scrollHeight - BOTTOM_PX) {
        atBottom.current = false;
        return;
      }
      tryGo();
    });
  }, [a.enabled, a.nextId, tryGo]);

  return { onScroll, atEnd: tryGo };
}
