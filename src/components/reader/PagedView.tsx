import { RetryableImage } from '@/components/RetryableImage';
import { IconBookmark } from '@/components/Icons';

/** 分页视图：一屏一页或两页，适合平板和显示器 */
export default function PagedView({
  images,
  startIndex,
  perPage,
  markedPages,
  filter,
  onTapZone,
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
  onTapZone: (side: 'left' | 'right' | 'center') => void;
  onZoom: (src: string, index: number) => void;
  edgeHint: React.ReactNode;
}) {
  return (
    <div className="reader__paged" style={{ filter }}>
      <div className={`reader__spread${perPage === 2 ? ' is-double' : ''}`}>
        {images.map((src, i) => {
          const abs = startIndex + i;
          return (
            <div key={src} className="reader__cell">
              <RetryableImage
                src={src}
                alt={`第 ${abs + 1} 页`}
                onDoubleClick={() => onZoom(src, abs)}
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
      <div className="paged-tap paged-tap--l" onClick={() => onTapZone('left')} />
      <div className="paged-tap paged-tap--r" onClick={() => onTapZone('right')} />
      <div className="paged-tap paged-tap--c" onClick={() => onTapZone('center')} />

      {edgeHint}
    </div>
  );
}
