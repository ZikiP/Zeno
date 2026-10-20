import { PageImage } from './PageImage';
import { IconBookmark } from '@/components/Icons';

/**
 * 一屏里的几张图（单页一张、双页两张）。
 *
 * 从 PagedView 拆出来是因为翻页那套双缓冲状态机已经够长了，
 * 而"这一屏画什么"跟"什么时候换台面"是两件事。
 */
export function PagedCells({
  list,
  base,
  markedPages,
  enhance,
  onZoom,
}: {
  /** 这一屏的图片地址 */
  list: string[];
  /** 这一屏第一张在整个章节里的序号，用来算绝对页号 */
  base: number;
  markedPages: Set<number>;
  /** 画面增强（实验） */
  enhance?: boolean;
  onZoom: (src: string, index: number) => void;
}) {
  return (
    <>
      {list.map((src, i) => {
        const abs = base + i;
        return (
          <div key={src} className="reader__cell">
            <PageImage
              src={src}
              alt={`第 ${abs + 1} 页`}
              enhance={enhance}
              /*
               * 这一张就是视口内容本身，必须 eager：lazy 的 <img> 刚挂上时
               * 浏览器可能推迟一帧才开始解码，而翻页动画正跑到一半。
               */
              eager
              fetchPriority="high"
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
    </>
  );
}
