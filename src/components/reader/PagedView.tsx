import { useEffect, useRef } from 'react';
import { RetryableImage } from '@/components/RetryableImage';
import { IconBookmark } from '@/components/Icons';

const SWIPE_PX = 44;

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
  onTapZone: (side: 'left' | 'right' | 'center') => void;
  onSwipe: (dir: 'forward' | 'back') => void;
  onZoom: (src: string, index: number) => void;
  edgeHint: React.ReactNode;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  /** 刚滑过就别再触发同一次的点击，否则一次手势翻两页 */
  const swiped = useRef(false);

  /*
   * 翻页方向。
   *
   * 比的是「上一次渲染时的 startIndex」—— 那个 ref 要到 effect 里才更新，
   * 所以本次渲染拿到的仍是旧值，正好用来判这一跳是往前还是往后。
   * 进度条拖拽、点目录切章都走同一条，不用每个入口各记一遍。
   */
  const prevStart = useRef(startIndex);
  useEffect(() => {
    prevStart.current = startIndex;
  }, [startIndex]);
  const forward = startIndex >= prevStart.current;

  /*
   * 3D 折页的参数。
   *
   * 书脊在哪边就绕哪条边折：左起阅读书脊在左，右起在右；回翻是镜像方向。
   * 只给当前这一屏开 3D —— 章节里几十张高清图，全都提合成层会把手机打爆。
   */
  const deg = (forward ? -72 : 72) * (rtl ? -1 : 1);
  const turnStyle = {
    '--turn-origin': rtl ? 'right center' : 'left center',
    '--turn-from': `${deg}deg`,
    '--turn-shade-dir': rtl ? 'to right' : 'to left',
  } as React.CSSProperties;

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
      <div
        key={startIndex}
        className={`reader__spread turn-in${perPage === 2 ? ' is-double' : ''}${
          rtl && perPage === 2 ? ' is-rtl' : ''
        }`}
        style={turnStyle}
      >
        {images.map((src, i) => {
          const abs = startIndex + i;
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
        })}
        {/*
          折页时的暗面。用一层覆盖物的 opacity 做，不动图片的 filter ——
          brightness 会让整层每帧重绘，1200×1700 的图上就是稳定掉帧。
        */}
        <div className="reader__turn-shade" aria-hidden="true" />
      </div>

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
