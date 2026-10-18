import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/** 手离开之后隔多久收回去。1 秒是"还在那儿按着"和"已经走了"的分界 */
const IDLE_MS = 1000;

/**
 * 底部进度条：平时是压在页面底的一道细线，按住它长成一枚可以拖的玻璃条。
 *
 * 为什么要二段：细线只有 3px，手指按不准，而它又是唯一能跳进度入口。
 * 所以底部留一条 44px 的拇指热区 —— 点它**不呼出菜单**，而是把细线撑开成
 * 带滑块的大条，拖到哪跳到哪；一秒不动再自动缩回去。
 *
 * 形变全在 `.reader__seek` 这一个元素上（bottom / height / left / right / padding），
 * 不是"旧的淡出 + 新的淡入"两块 DOM 换位 —— 那样看着是闪，不是长。
 */
export default function ReaderProgress({
  percent,
  markedPositions,
  hudVisible,
  onSeek,
  onSeekEnd,
  onRequestOpen,
}: {
  /** 0-100 */
  percent: number;
  /** 已收藏页在整章里的百分比位置 */
  markedPositions: number[];
  /** 顶部菜单展开了：两个悬浮件不叠着摆 */
  hudVisible?: boolean;
  /**
   * 跳到这一章的哪个位置，0-1。拖动过程中会连续调用。
   * 分页模式是"第几屏"，滚动模式是滚动比例（和存下来的进度同一个口径）。
   * 传 null 表示这一章没什么可跳的（只有一张图）。
   */
  onSeek: ((ratio: number) => void) | null;
  /** 抬手那一刻。"拖到最右端 = 下一章"这种只在终点成立的动作放这儿，别混进拖动里 */
  onSeekEnd?: (ratio: number) => void;
  /**
   * 要展开了，知会外面一声。
   * 大条浮在离底 26px，正好是「上一章 / 下一章」那颗胶囊的位置 —— 那颗胶囊跟着
   * 顶部菜单一起显隐，所以这里把菜单关掉，两个悬浮件就不会叠在一起。
   * 反过来顶部菜单被呼出时，下面那个 effect 会把这条收回去。
   */
  onRequestOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const idle = useRef<number>();

  const arm = useCallback(() => {
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => {
      /* 按住不放不算"没操作"，不然拖到一半条缩回去了 */
      if (!dragging.current) setOpen(false);
    }, IDLE_MS);
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(idle.current);
    },
    [],
  );

  /* 菜单展开时收回：不然顶部那套悬浮件和这枚条同时在屏幕上抢注意力 */
  useEffect(() => {
    if (hudVisible) setOpen(false);
  }, [hudVisible]);

  /** 把指针的 x 换算成 0-1。按轨道自己的矩形算，展开后轨道是内缩的，才不会错位 */
  const ratioAt = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return null;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    /* 捕获住：手指拖出这条 44px 热区还得继续跟着走 */
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragging.current = true;
    setOpen(true);
    onRequestOpen?.();
    arm();
    const r = ratioAt(e.clientX);
    if (r !== null) onSeek(r);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !onSeek) return;
    const r = ratioAt(e.clientX);
    if (r === null) return;
    onSeek(r);
    arm();
  };

  const stop = (e: ReactPointerEvent<HTMLDivElement>, settled: boolean) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (settled) {
      const r = ratioAt(e.clientX);
      if (r !== null) onSeekEnd?.(r);
    }
    arm();
  };

  return (
    <div
      className={`reader__progress${open ? ' is-open' : ''}`}
      aria-label="阅读进度"
      title="按住拖动跳进度"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => stop(e, true)}
      onPointerCancel={(e) => stop(e, false)}
    >
      <div className="reader__seek">
        <div className="reader__track" ref={trackRef}>
          <div className="reader__progress-fill" style={{ width: `${percent}%` }} />
          {markedPositions.map((p, i) => (
            <span key={i} className="reader__progress-bm" style={{ left: `${p.toFixed(2)}%` }} />
          ))}
          <div className="reader__progress-thumb" style={{ left: `${percent}%` }} />
        </div>
      </div>
    </div>
  );
}
