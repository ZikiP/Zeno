import { RetryableImage } from '@/components/RetryableImage';
import { IconBookmark } from '@/components/Icons';

/** 竖向滚动视图：连续下滑，适合手机和长章节 */
export default function ScrollView({
  images,
  markedPages,
  filter,
  containerRef,
  onScroll,
  onTap,
  onZoom,
}: {
  images: string[];
  markedPages: Set<number>;
  filter?: string;
  /**
   * 滚动容器本身的引用。恢复上次位置要用它 —— 这个 ref 之前没有接进来，
   * scrollRef.current 一直是 null，于是「继续阅读」只换章、不回位置，
   * 而且看不出哪里错了（记录进度走的是 onScroll，那条是好的）。
   */
  containerRef?: React.RefObject<HTMLDivElement>;
  onScroll: (el: HTMLDivElement) => void;
  onTap: () => void;
  onZoom: (src: string, index: number) => void;
}) {
  return (
    <div
      className="reader__scroll"
      ref={containerRef}
      style={{ filter }}
      onScroll={(e) => onScroll(e.currentTarget)}
    >
      {images.map((src, i) => (
        <div key={src + i} className="reader__item">
          <RetryableImage
            className="reader__page"
            src={src}
            alt={`第 ${i + 1} 页`}
            eager={i < 3}
            onClick={onTap}
            onDoubleClick={() => onZoom(src, i)}
            onContextMenu={(e) => {
              e.preventDefault();
              onZoom(src, i);
            }}
          />
          {markedPages.has(i) && (
            <span className="reader__bm-mark" title="已收藏">
              <IconBookmark size={13} filled />
            </span>
          )}
        </div>
      ))}
      <div className="reader__end">— 本章完 —</div>
    </div>
  );
}
