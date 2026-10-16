import { useRef } from 'react';

/** 横向位移超过这么多、且明显比纵向多，才算滑动 */
const SWIPE_PX = 44;

/**
 * 分页视图的手势：横滑翻页 + 点区分级。
 *
 * 滑过之后要把紧随其后的那一次 click 吞掉 —— 手指抬起浏览器还会补一次点击，
 * 不吞的话一次滑动会翻两页。
 *
 * enabled=false 时滑动不再翻页：放大之后横着拖是要看图片溢出的那一截，
 * 拖到边就跳页的话没人受得了。点区照旧，翻页这条路还剩点击一条。
 */
export function usePagedGesture(args: {
  rtl: boolean;
  enabled: boolean;
  onSwipe: (dir: 'forward' | 'back') => void;
  onTapZone: (side: 'left' | 'right' | 'center') => void;
}) {
  const { rtl, enabled, onSwipe, onTapZone } = args;
  const start = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY };
    swiped.current = false;
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || !enabled) return;
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

  return { onTouchStart, onTouchEnd, tap };
}
