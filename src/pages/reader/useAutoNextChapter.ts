import { useCallback, useEffect, useRef, useState } from 'react';
import { isImageReady, onImageStateChange } from '@/components/RetryableImage';
import {
  advancePull,
  BOTTOM_PX,
  RELEASE_PX,
  safePullMs,
  wheelStillActive,
} from './pullCharge';

/**
 * 读到底自动接下一章 —— 上拉蓄力，松手取消
 *
 * 停在章末那一屏之后，要接下一章得**持续上拉一段**（默认 1.5 秒）。
 * 为什么不是一到底就跳：那样上一章的结尾连回看的机会都没有，而章末恰恰最该看
 * （伏笔、下章预告、"— 本章完 —"）。也不只是"再推一下就跳"：一次误滑、
 * 手指在屏幕上蹭一下，就会又跳过去一章，回味还得翻目录。所以要**按住不放、
 * 看着那一圈环填满**才作数，中途松手就退回去。
 *
 * 拉力攒在 `accMs` 上，按**时间**算而不是按拖动距离：手机滚到底之后手指原地按着
 * 不动，`touchmove` 不再来，只看事件的话进度会僵住 —— 而用户的直觉正是
 * "我一直拉着"。所以事件只负责把"在拉"这件事告诉状态机，攒时间交给帧。
 * 时间差用两次时刻相减，不假设帧率，页面被系统冻过一段时间也能一次追平。
 *
 * 最后那张图还没落地时**不给跳**（它的高度还没进 scrollHeight，此刻的"底部"是假的，
 * 跳过去就把这一章的尾巴翻过去了）：环停在满的位置、文案说明在等什么，
 * 图一落地就接着攒。
 *
 * 翻页模式不走这一套：停在最后一页本身就是一屏看得见的画面，
 * 再往前翻一次即接，不加门槛。章末那一行点一下也直接接 —— 点是明确意图，
 * 蓄力防的是"滑过头"，不是防"照着字按下去"。
 */

export function useAutoNextChapter(a: {
  enabled: boolean;
  /** 要攒多久。设置里那根滑条说的就是它 */
  pullMs: number;
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
  const arm = useCallback((on: boolean) => {
    if (armedRef.current === on) return;
    armedRef.current = on;
    setArmed(on);
  }, []);

  const [pull, setPull] = useState(0);
  const accMs = useRef(0);
  const lastAt = useRef(0);
  const held = useRef(false);
  const wheelAt = useRef(0);
  const raf = useRef(0);
  const fired = useRef(false);

  /* 最后一张图落地时刷一次，让文案和蓄力跟上 */
  const [, bump] = useState(0);
  useEffect(() => {
    if (!a.enabled || !a.nextId) return;
    return onImageStateChange(() => bump((n) => n + 1));
  }, [a.enabled, a.nextId]);

  /** 换章：闩、环、提示都重来 */
  useEffect(() => {
    fired.current = false;
    accMs.current = 0;
    held.current = false;
    setPull(0);
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
    held.current = false;
    accMs.current = 0;
    setPull(0);
    arm(false);
    cur.onGo(cur.nextId);
  }, [arm, lastLanded]);

  const stop = useCallback(() => {
    if (!raf.current) return;
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  }, []);

  /** 组件卸载必须停帧，不然回调会打在已经没了的 state 上 */
  useEffect(() => stop, [stop]);

  /**
   * 攒一下。事件（滚轮、手指、帧）都汇到这里，差别只在"现在还在拉吗"：
   * 手指按着算、滚轮 400ms 内有动静算。没在拉就往回退，退到 0 停帧。
   * 攒多少、够不够、退多快，都在 advancePull 里（有测试钉着）。
   */
  const tick = useCallback(() => {
    const now = performance.now();
    const dt = lastAt.current ? now - lastAt.current : 0;
    lastAt.current = now;
    const cur = live.current;
    const need = safePullMs(cur.pullMs);
    const active =
      cur.enabled &&
      !!cur.nextId &&
      !fired.current &&
      armedRef.current &&
      (held.current || wheelStillActive(wheelAt.current, now));

    const next = advancePull(accMs.current, dt, { active, landed: lastLanded(), pullMs: need });
    accMs.current = next.accMs;
    const p = Math.min(1, accMs.current / need);
    /*
     * 量化成 20 档再进 state。这个 hook 挂在 ReaderPage 上，setPull 一次就是
     * 整页重渲一次（包括那几十张图的协调）—— 按帧报进度等于给一个本来就
     * 要画满屏的页面再加 60fps 的活，卡的反而是这个动画本身。
     * 一圈 20px 的环分 20 段，肉眼看不出比按帧少。
     */
    const q = Math.round(p * 20) / 20;
    setPull((prev) => (prev === q ? prev : q));
    if (next.done) {
      stop();
      go();
      return;
    }
    if (active || accMs.current > 0) raf.current = requestAnimationFrame(tick);
    else stop();
  }, [go, lastLanded, stop]);

  const kick = useCallback(() => {
    if (raf.current) return;
    lastAt.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  }, [tick]);

  /** 到底之前的一次向下动作不算上拉（那只是普通滚动） */
  const pullStart = useCallback(() => {
    if (!armedRef.current || fired.current) return;
    wheelAt.current = performance.now();
    kick();
  }, [kick]);

  const pullHold = useCallback(
    (on: boolean) => {
      if (!armedRef.current || fired.current) return;
      held.current = on;
      if (on) wheelAt.current = performance.now();
      kick();
    },
    [kick],
  );

  const onScroll = useCallback(
    (el: HTMLElement) => {
      const scrollable = el.scrollHeight - el.clientHeight;
      // 一屏就放得下的章节没有"章末"可言，别让它在挂上那一刻就等着跳
      if (scrollable <= 0) return arm(false);
      const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
      if (distance <= BOTTOM_PX) arm(true);
      else if (distance > RELEASE_PX) {
        // 人往回滚了。蓄到一半的力立刻清空，不许"攒着"下一次用
        held.current = false;
        accMs.current = 0;
        setPull(0);
        arm(false);
      }
    },
    [arm],
  );

  /** 章末那一行被点下去：明确意图，直接接 */
  const tapEnd = useCallback(() => go(), [go]);

  const ready = lastLanded();
  return {
    onScroll,
    pullStart,
    pullHold,
    /** 分页模式的"再往前翻一次"和键盘前进 */
    atEnd: go,
    tapEnd,
    /** 停在章末、可以开始蓄力 —— 那一行的提示该出现了 */
    armed: armed && !!a.nextId && a.enabled,
    /** 0–1，那一圈环按它画 */
    pull,
    ready,
  };
}
