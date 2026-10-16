import { useCallback, useEffect, useRef, useState } from 'react';

/** 最大倍率。再往上就是像素糊成一团，要看细节该用「原始尺寸」那一档而不是放大 */
const MAX_SCALE = 4;

/** 松手时倍率离 1 差不到这么多就吸附回 1 —— 误碰第二根手指不该让页面凭空放大一档还蹦出还原按钮 */
const SNAP_BACK = 0.02;

export interface PinchState {
  scale: number;
  /** 平移，屏幕像素（translate 排在 scale 前面，所以不随倍率缩放） */
  x: number;
  y: number;
}

const IDLE: PinchState = { scale: 1, x: 0, y: 0 };

/** 一次捏合的起点 */
interface Pinch {
  /** 起始两指距离 */
  d: number;
  mx: number;
  my: number;
  from: PinchState;
  /** 元素不放大时中心在哪 —— 焦点不变式的原点 */
  cx: number;
  cy: number;
}

/**
 * 双指缩放。
 *
 * 手势必须用原生监听挂：React 18 把 root 上的 touchmove 注册成 passive，
 * handler 里 preventDefault 不生效，双指时压不住浏览器的滚动和整页缩放。
 *
 * 倍率活在这里，怎么落到 DOM 上由调用方的 apply 决定 —— 分页用 transform
 * （图片尺寸是 object-fit 四档算出来的，只有 transform 能叠在它上面），
 * 滚动用 zoom 属性（要真实撑开盒子，后面的图才会往下推、滚动区才会变长）。
 *
 * 抬起手指**不**还原，缩放态一直留着，还原是右下角那颗按钮的活；
 * 换屏、换章、菜单展开时由 resetKey / enabled 归位。
 */
export function usePinchZoom({
  container,
  target,
  enabled,
  clampPan,
  resetKey,
  resetToken,
  apply,
  onZoomedChange,
}: {
  /** 手势挂在这个元素上 */
  container: React.RefObject<HTMLElement | null>;
  /** 这次捏合缩放哪个元素；返回 null 就不响应 */
  target: (e: TouchEvent) => HTMLElement | null;
  /** 菜单展开时不收手势，已放大的顺手还原 */
  enabled: boolean;
  /** 平移夹在图片边界内（分页）；滚动模式交给原生滚动，不夹 */
  clampPan: boolean;
  /** 变了就还原：页号、章节 */
  resetKey: unknown;
  /** 变了也还原：右下角那颗按钮按下去 */
  resetToken?: unknown;
  apply: (
    el: HTMLElement,
    next: PinchState,
    prev: PinchState,
    mid: { x: number; y: number },
  ) => void;
  onZoomedChange: (zoomed: boolean) => void;
}) {
  const [zoomed, setZoomed] = useState(false);
  const state = useRef<PinchState>(IDLE);
  /** 当前被放大的那个元素 */
  const node = useRef<HTMLElement | null>(null);
  /** 一次放大期间元素的尺寸，夹平移用。捏合结束、单指拖着看的时候还要用 */
  const bounds = useRef<{ w: number; h: number; stageW: number; stageH: number } | null>(null);
  const pinch = useRef<Pinch | null>(null);
  /** 放大态下的单指平移 */
  const drag = useRef<{ mx: number; my: number; from: PinchState } | null>(null);

  /* 监听只挂一次，所以每次都把最新的入参挪进 ref */
  const live = useRef({ target, enabled, clampPan, apply, onZoomedChange });
  useEffect(() => {
    live.current = { target, enabled, clampPan, apply, onZoomedChange };
  });

  /** 落一次状态。mid 是这次的手指的锚点，滚动模式要拿它补滚动位置 */
  const push = useCallback((next: PinchState, mid: { x: number; y: number }) => {
    const el = node.current;
    if (!el) return;
    const prev = state.current;
    state.current = next;
    live.current.apply(el, next, prev, mid);
    const on = next.scale > 1 + SNAP_BACK;
    setZoomed((v) => (v === on ? v : on));
    live.current.onZoomedChange(on);
  }, []);

  const reset = useCallback(() => {
    const el = node.current;
    if (!el || state.current.scale === 1) return;
    bounds.current = null;
    pinch.current = null;
    drag.current = null;
    push(IDLE, { x: 0, y: 0 });
  }, [push]);

  /* 换屏 / 换章 / 菜单展开 / 点了还原：放大都不该留着 */
  useEffect(reset, [resetKey, resetToken, enabled, reset]);

  useEffect(() => {
    const box = container.current;
    if (!box) return;

    /** 夹平移：放大出来的那一圈不许移出画面，否则图片边缘会缩进屏幕里 */
    const clamp = (v: number, limit: number) => Math.min(limit, Math.max(-limit, v));

    const start = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        drag.current = null;
        if (!live.current.enabled) return;
        const el = live.current.target(e);
        if (!el) return;
        /* 一次只留一张放大的图：捏新的先把上一张归位 */
        if (node.current && node.current !== el) {
          const prev = state.current;
          state.current = IDLE;
          live.current.apply(node.current, IDLE, prev, { x: 0, y: 0 });
        }
        node.current = el;

        const a = e.touches[0];
        const b = e.touches[1];
        const r = el.getBoundingClientRect();
        const k = state.current.scale || 1;
        const stage = box.getBoundingClientRect();
        bounds.current = {
          w: r.width / k,
          h: r.height / k,
          stageW: stage.width,
          stageH: stage.height,
        };
        pinch.current = {
          d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
          mx: (a.clientX + b.clientX) / 2,
          my: (a.clientY + b.clientY) / 2,
          from: state.current,
          /* 量到的中心已经带着平移，减回去才是「不放大时中心在哪」 */
          cx: r.left + r.width / 2 - state.current.x,
          cy: r.top + r.height / 2 - state.current.y,
        };
        return;
      }
      /* 只有放大之后单指拖动才平移；没放大时这一根手指是翻页、是滚动 */
      if (e.touches.length === 1 && state.current.scale > 1 && live.current.clampPan) {
        const t = e.touches[0];
        drag.current = { mx: t.clientX, my: t.clientY, from: state.current };
      }
    };

    const move = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const p = pinch.current;
        if (!p) return;
        /* 不拦住的话浏览器会一边滚、一整个文档一边跟着缩放 */
        e.preventDefault();
        const a = e.touches[0];
        const b = e.touches[1];
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const scale = Math.min(MAX_SCALE, Math.max(1, (p.from.scale * d) / p.d));
        const mx = (a.clientX + b.clientX) / 2;
        const my = (a.clientY + b.clientY) / 2;
        /*
         * 焦点不变式：捏合中点底下的那个内容点，缩放前后都还在中点底下。
         * r 是这一次捏合从起点算起的增量比例，不是当前倍率。
         */
        const r = scale / (p.from.scale || 1);
        let x = mx - p.cx - r * (p.mx - p.cx - p.from.x);
        let y = my - p.cy - r * (p.my - p.cy - p.from.y);
        const bd = bounds.current;
        if (live.current.clampPan && bd) {
          x = clamp(x, Math.max(0, (scale * bd.w - bd.stageW) / 2));
          y = clamp(y, Math.max(0, (scale * bd.h - bd.stageH) / 2));
        }
        push({ scale, x, y }, { x: mx, y: my });
        return;
      }
      const d = drag.current;
      const bd = bounds.current;
      if (e.touches.length === 1 && d && bd) {
        e.preventDefault();
        const t = e.touches[0];
        const k = state.current.scale;
        push(
          {
            ...state.current,
            x: clamp(d.from.x + (t.clientX - d.mx), Math.max(0, (k * bd.w - bd.stageW) / 2)),
            y: clamp(d.from.y + (t.clientY - d.my), Math.max(0, (k * bd.h - bd.stageH) / 2)),
          },
          { x: t.clientX, y: t.clientY },
        );
      }
    };

    const end = (e: TouchEvent) => {
      if (e.touches.length < 2 && pinch.current) {
        pinch.current = null;
        /* 只是蹭到第二根手指的话，回到没放大的样子，别留个半吊子的放大态 */
        if (state.current.scale <= 1 + SNAP_BACK) push(IDLE, { x: 0, y: 0 });
      }
      if (e.touches.length === 0) drag.current = null;
    };

    const opts = { passive: false } as const;
    box.addEventListener('touchstart', start, opts);
    box.addEventListener('touchmove', move, opts);
    box.addEventListener('touchend', end, opts);
    box.addEventListener('touchcancel', end, opts);
    return () => {
      box.removeEventListener('touchstart', start);
      box.removeEventListener('touchmove', move);
      box.removeEventListener('touchend', end);
      box.removeEventListener('touchcancel', end);
    };
  }, [container, push]);

  return { zoomed, reset };
}
