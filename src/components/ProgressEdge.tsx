import { useEffect, useRef, useState } from 'react';

const STROKE = 2.5;

/** 圆角矩形路径 + 周长。inset 把描边整个收进盒子内沿，不骑到边界上 */
function edge(w: number, h: number, radius: number, inset: number) {
  const ww = w - inset * 2;
  const hh = h - inset * 2;
  /* 往里缩一档之后，圆角的同心半径要跟着减掉 inset，不然角上会差出描边宽度那么多 */
  const r = Math.max(0, Math.min(radius - inset, ww / 2, hh / 2));
  const x2 = inset + ww;
  const y2 = inset + hh;
  return {
    d:
      `M${inset + r},${inset} H${x2 - r}` +
      `A${r},${r} 0 0 1 ${x2},${inset + r} V${y2 - r}` +
      `A${r},${r} 0 0 1 ${x2 - r},${y2} H${inset + r}` +
      `A${r},${r} 0 0 1 ${inset},${y2 - r} V${inset + r}` +
      `A${r},${r} 0 0 1 ${inset + r},${inset} Z`,
    /* 四条直边 + 四个角拼起来的一整圈 = 2πr 的弧长 */
    per: 2 * (ww - 2 * r) + 2 * (hh - 2 * r) + 2 * Math.PI * r,
  };
}

/**
 * 绕卡片一周的阅读进度。
 *
 * 尺寸是量出来的：SVG 铺满卡片，ResizeObserver 读出真实宽高和卡片的圆角，
 * 再算路径与周长。没走 `<rect pathLength>` 那条捷径 —— 它在部分引擎上不生效，
 * 周长一错进度就悄悄画错，而这圈描边上没有数字，画错了没人看得出来。
 *
 * 起点在左上角那条直边的头，顺时针走。
 */
export default function ProgressEdge({ percent, label }: { percent: number; label: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState<{ d: string; per: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      const radius = parseFloat(getComputedStyle(el.parentElement!).borderRadius) || 0;
      if (width < 1 || height < 1) return;
      setBox(edge(width, height, radius, STROKE / 2));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const p = Math.max(0, Math.min(100, Math.round(percent)));

  return (
    <svg ref={ref} className="card__edge" role="img" aria-label={label}>
      <title>{label}</title>
      {box && (
        <>
          <path className="card__edge-track" d={box.d} strokeWidth={STROKE} fill="none" />
          <path
            className="card__edge-arc"
            d={box.d}
            strokeWidth={STROKE}
            fill="none"
            strokeDasharray={box.per}
            strokeDashoffset={box.per * (1 - p / 100)}
          />
        </>
      )}
    </svg>
  );
}
