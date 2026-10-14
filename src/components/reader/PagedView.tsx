import { useRef } from 'react';
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
        className={`reader__spread${perPage === 2 ? ' is-double' : ''}${
          rtl && perPage === 2 ? ' is-rtl' : ''
        }`}
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
