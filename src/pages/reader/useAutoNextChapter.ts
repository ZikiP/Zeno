import { useCallback, useEffect, useRef, useState } from 'react';
import { isImageReady, onImageStateChange } from '@/components/RetryableImage';

/**
 * 读到底自动接下一章
 *
 * 两种模式两条路，但都不是"到底那一瞬间就飞走"：
 *
 *  - **滚动**：到底先**停在「本章完」那一屏**，把这一章的结尾留在眼前。
 *    要接下一章得再给一次**明确的向下意图** —— 再推一下（滚轮 / 新一次触摸拖动）、
 *    点那一行、或者按一次翻页键。之所以要"再一下"而不是一到就跳：
 *    实测一拉到底人就跳走了，上一章最后那几屏连回看的机会都没有，
 *    而章末恰恰是最该看的地方（伏笔、下章预告、"— 本章完 —"）。
 *  - **分页**：停在最后一页本来就是"看得见的一屏"，再往前翻一次即跳，不另加门槛。
 *
 * 为什么要等最后一张图落地：图片是 lazy 的，它没落地时那块高度还没进
 * `scrollHeight`，此刻的"底部"不是真底部 —— 这时跳会把这一章的尾巴翻过去。
 * 所以到底 + 最后一张能画，两样齐了才算"可以接下一章"；
 * 图落地时刷一次状态，让那行提示从"正在取最后几张"变成"再往下推一下"。
 *
 * 冷却那 350ms 是给手机惯性的：手指一路滑到底时，尾部还会挤进来几个事件，
 * 没有它就等于一次滑动两下都算，第一段白留了。
 *
 * 一章只跳一次的闩也是必须的：跳过去之后新章很短的话一挂上就是底部，
 * 没闩会连着跳两三章。
 */
const BOTTOM_PX = 48;
/** 离底超过这个距离就不再算"停在章末"（留宽一点，回弹和抖动不会把提示闪掉） */
const RELEASE_PX = 160;
const ARM_COOLDOWN_MS = 350;

export function useAutoNextChapter(a: {
  enabled: boolean;
  nextId: string | null;
  images: string[] | null;
  onGo: (chapterId: string) => void;
}) {
  /** 最新那份参数。事件回调要读到当前章、当前开关，不能抱着第一次渲染的闭包 */
  const live = useRef(a);
  useEffect(() => {
    live.current = a;
  });

  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const armedAt = useRef(0);
  const arm = useCallback((on: boolean) => {
    if (armedRef.current === on) return;
    armedRef.current = on;
    if (on) armedAt.current = Date.now();
    setArmed(on);
  }, []);

  const fired = useRef(false);

  /* 最后一张图落地时刷一次，让提示文案跟上 */
  const [, bump] = useState(0);
  useEffect(() => {
    if (!a.enabled || !a.nextId) return;
    return onImageStateChange(() => bump((n) => n + 1));
  }, [a.enabled, a.nextId]);

  /* 换章：闩和提示都重来 */
  useEffect(() => {
    fired.current = false;
    arm(false);
  }, [a.nextId, a.images, arm]);

  const lastLanded = useCallback(() => {
    const imgs = live.current.images;
    const last = imgs?.[imgs.length - 1];
    return !last || isImageReady(last);
  }, []);

  const go = useCallback(() => {
    const cur = live.current;
    if (!cur.enabled || !cur.nextId || fired.current) return;
    if (!lastLanded()) return;
    fired.current = true;
    arm(false);
    cur.onGo(cur.nextId);
  }, [arm, lastLanded]);

  /**
   * 第二次向下意图。没开关着、还没到底、或者刚到底不到 350ms，都不算。
   * 最后一张还没落地时也**不跳**，但提示会说明在等什么。
   */
  const pullDown = useCallback(() => {
    if (!armedRef.current) return;
    if (Date.now() - armedAt.current < ARM_COOLDOWN_MS) return;
    go();
  }, [go]);

  const onScroll = useCallback(
    (el: HTMLElement) => {
      const scrollable = el.scrollHeight - el.clientHeight;
      // 一屏就放得下的章节没有"章末"可言，别让它在挂上那一刻就等着跳
      if (scrollable <= 0) return arm(false);
      const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
      if (distance <= BOTTOM_PX) arm(true);
      else if (distance > RELEASE_PX) arm(false);
    },
    [arm],
  );

  return {
    onScroll,
    pullDown,
    /** 分页模式：最后一页再往前翻一次，直接接 */
    atEnd: go,
    /** 章末停住了、可以接下一章 —— 那行提示该出现了 */
    armed: armed && !!a.nextId && a.enabled,
    /** 提示该怎么说：还在等最后几张图 vs 可以推了 */
    ready: lastLanded(),
  };
}
