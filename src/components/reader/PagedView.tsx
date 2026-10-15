import { useEffect, useRef, useState } from 'react';
import { RetryableImage } from '@/components/RetryableImage';
import { IconBookmark } from '@/components/Icons';

const SWIPE_PX = 44;

/** 一次还没演完的翻页：上一页的内容 + 方向 */
interface Turn {
  images: string[];
  startIndex: number;
  forward: boolean;
}

/**
 * 分页视图：一屏一页或两页，适合平板和显示器。
 *
 * 翻页有两种输入，必须走同一套方向语义：
 *   - 点击左右区域（tap 区）
 *   - 横向滑动（手机上更自然，之前完全没做）
 * rtl 时两者都反过来：点左/向右滑 = 前进。
 */
export default function PagedView({
  images,
  startIndex,
  perPage,
  markedPages,
  filter,
  rtl,
  turnKey,
  onTapZone,
  onSwipe,
  onZoom,
  edgeHint,
}: {
  /** 当前屏要显示的图片（已按 perPage 切好） */
  images: string[];
  /** 当前屏第一张在整个章节里的序号 */
  startIndex: number;
  perPage: number;
  markedPages: Set<number>;
  filter?: string;
  /** 右起阅读：双页时左右要互换，滑动方向也要反过来 */
  rtl: boolean;
  /** 换章时变一下。翻页动画只在同一章内演 —— 跨章不该有"上一页" */
  turnKey: string;
  onTapZone: (side: 'left' | 'right' | 'center') => void;
  onSwipe: (dir: 'forward' | 'back') => void;
  onZoom: (src: string, index: number) => void;
  edgeHint: React.ReactNode;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  /** 刚滑过就别再触发同一次的点击，否则一次手势翻两页 */
  const swiped = useRef(false);

  /*
   * 上一次真正显示在屏幕上的内容。
   *
   * 翻页要连续，就得让前后两页同时在场：旧的留在 DOM 里演完，而不是被
   * React 就地换掉 —— 一换就空一帧，那一下就是用户说的"闪"。
   */
  const [turn, setTurn] = useState<Turn | null>(null);
  const shown = useRef({ images, startIndex, turnKey });

  useEffect(() => {
    const prev = shown.current;
    shown.current = { images, startIndex, turnKey };
    // 换章（turnKey 变）或位置没动，都不演翻页
    if (prev.turnKey !== turnKey || prev.startIndex === startIndex) return;
    setTurn({
      images: prev.images,
      startIndex: prev.startIndex,
      forward: startIndex > prev.startIndex,
    });
  }, [startIndex, images, turnKey]);

  /*
   * 3D 折页的参数。
   *
   * 书脊在哪边就绕哪条边折：左起书脊在左、右起在右。
   * 转到 ±90° 而不是 72° —— 纸页侧立时宽度为零，动画结束时撤掉它没有跳变；
   * 停在 72° 的话，撤掉那一帧还剩一条边，看着就是又闪一下。
   * 只给正在演的那一层开 will-change/3D —— 章节里几十张高清图全提合成层
   * 会把手机打爆。
   */
  const turnStyle = {
    '--turn-origin': rtl ? 'right center' : 'left center',
    '--turn-to': `${rtl ? 90 : -90}deg`,
    '--turn-shade-dir': rtl ? 'to right' : 'to left',
  } as React.CSSProperties;

  const spreadClass = (extra: string) =>
    `reader__spread${extra}${perPage === 2 ? ' is-double' : ''}${
      rtl && perPage === 2 ? ' is-rtl' : ''
    }`;

  const cells = (list: string[], base: number) =>
    list.map((src, i) => {
      const abs = base + i;
      return (
        <div key={src} className="reader__cell">
          <RetryableImage
            src={src}
            alt={`第 ${abs + 1} 页`}
            onDoubleClick={() => onZoom(src, abs)}
            onContextMenu={(e) => {
              e.preventDefault();
              onZoom(src, abs);
            }}
          />
          {markedPages.has(abs) && (
            <span className="reader__bm-mark" title="已收藏">
              <IconBookmark size={13} filled />
            </span>
          )}
        </div>
      );
    });

  /*
   * 暗面/投影的 animationend 会从子元素冒泡上来，只认演翻页那一层自己的。
   * 认错了会在动画演到一半时把上一页撤掉，留下半张纸的跳变。
   */
  const endTurn = (e: React.AnimationEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    setTurn(null);
  };

  const touchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY };
    swiped.current = false;
  };

  const touchEnd = (e: React.TouchEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    swiped.current = true;
    onSwipe(rtl ? (dx > 0 ? 'forward' : 'back') : dx < 0 ? 'forward' : 'back');
  };

  const tap = (side: 'left' | 'right' | 'center') => {
    if (swiped.current) {
      swiped.current = false;
      return;
    }
    onTapZone(side);
  };

  return (
    <div
      className="reader__paged"
      style={{ filter, touchAction: 'pan-y' }}
      onTouchStart={touchStart}
      onTouchEnd={touchEnd}
    >
      {/*
        双页时 rtl 用 row-reverse 而不是重排数组：DOM 顺序保持原样，
        startIndex + i 算出的绝对页号才不会错，书签标记和 alt 也就不会错位。
      */}
      {!turn && <div className={spreadClass('')}>{cells(images, startIndex)}</div>}

      {turn?.forward && (
        <>
          {/* 新页躺在下面，一动不动 —— 它不需要演，被露出来就是它的动画 */}
          <div className={spreadClass(' is-under')}>
            {cells(images, startIndex)}
            <div className="reader__turn-cast" aria-hidden="true" />
          </div>
          {/* 旧页抬起来让位 */}
          <div
            className={spreadClass(' is-over turn-out')}
            style={turnStyle}
            onAnimationEnd={endTurn}
          >
            {cells(turn.images, turn.startIndex)}
            <div className="reader__turn-shade" aria-hidden="true" />
          </div>
        </>
      )}

      {turn && !turn.forward && (
        <>
          {/* 回翻：旧页在下面等着被盖住 */}
          <div className={spreadClass(' is-under')}>
            {cells(turn.images, turn.startIndex)}
            <div className="reader__turn-cast" aria-hidden="true" />
          </div>
          {/* 新页从折痕里落下去 */}
          <div
            className={spreadClass(' is-over turn-in')}
            style={turnStyle}
            onAnimationEnd={endTurn}
          >
            {cells(images, startIndex)}
            <div className="reader__turn-shade" aria-hidden="true" />
          </div>
        </>
      )}

      {/*
        点击区三段划分：左右各 32% 翻页，中间 36% 只切工具栏。
        中间留这么宽是为了避免「想看工具栏却翻页了」这种误触 ——
        这是实测里最影响阅读体验的问题。
      */}
      <div className="paged-tap paged-tap--l" onClick={() => tap('left')} />
      <div className="paged-tap paged-tap--r" onClick={() => tap('right')} />
      <div className="paged-tap paged-tap--c" onClick={() => tap('center')} />

      {edgeHint}
    </div>
  );
}
