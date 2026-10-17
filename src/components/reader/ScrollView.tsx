import { useCallback, useEffect, useRef } from 'react';
import { RetryableImage } from '@/components/RetryableImage';
import { IconBookmark } from '@/components/Icons';
import { usePinchZoom, type PinchState } from './usePinchZoom';

/** 竖向滚动视图：连续下滑，适合手机和长章节 */
export default function ScrollView({
  images,
  markedPages,
  filter,
  containerRef,
  hudVisible,
  resetToken,
  onScroll,
  onTap,
  onZoom,
  onZoomedChange,
  onPullDown,
  endHint,
  onEndTap,
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
  /** 顶部菜单展开中：这时候不收双指手势，已放大的顺手还原 */
  hudVisible: boolean;
  /** 变一次还原一次：右下角那颗按钮 */
  resetToken: number;
  onScroll: (el: HTMLDivElement) => void;
  onTap: () => void;
  onZoom: (src: string, index: number) => void;
  onZoomedChange: (zoomed: boolean) => void;
  /**
   * 已经停在章末时用户又往下推了一下（滚轮 / 新一次触摸拖动）。
   * 这里只负责"报告有这个意图"，该不该跳由 useAutoNextChapter 判 ——
   * 到底那一瞬间的惯性尾巴事件也算它报过，所以判的那一侧留了冷却。
   */
  onPullDown?: () => void;
  /** 章末那一行的提示文案。给了它，那一行就变成可点的 */
  endHint?: string | null;
  onEndTap?: () => void;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const box = containerRef ?? ownRef;

  /*
   * 双指放大落在图片自己的宽度上：量一次不放大时多宽，乘上倍率写成 px。
   * 高跟着按图片比例长（顺手把 height:auto 钉上，四档适配里那两档会把它钉死），
   * 于是后面的图被往下推、右边溢出成可滚的范围 —— 平移就交给原生滚动。
   *
   * 不能用 transform：它不参与布局，放大后这张图会盖住下面那张。
   * 也不能用 zoom：宽是 100% 来的，百分比按没缩放的父级算，乘完等于什么都没变（实测过）。
   */
  const apply = useCallback(
    (el: HTMLElement, next: PinchState, prev: PinchState, mid: { x: number; y: number }) => {
      const r = el.getBoundingClientRect();
      const w0 = r.width / (prev.scale || 1);
      if (next.scale > 1) {
        el.style.width = `${w0 * next.scale}px`;
        el.style.height = 'auto';
        el.style.maxWidth = 'none';
        el.style.maxHeight = 'none';
      } else {
        el.style.width = '';
        el.style.height = '';
        el.style.maxWidth = '';
        el.style.maxHeight = '';
      }
      const scroller = box.current;
      if (!scroller || next.scale === prev.scale || prev.scale <= 0) return;
      /*
       * 盒子是从左上角长开的，于是捏合中点底下的内容会朝右下方跑开。
       * 补一次滚动量把它拉回手指下面 —— 差的就是那点增量。
       */
      const k = next.scale / prev.scale - 1;
      scroller.scrollLeft += (mid.x - r.left) * k;
      scroller.scrollTop += (mid.y - r.top) * k;
    },
    [box],
  );

  const { zoomed } = usePinchZoom({
    container: box,
    /* 捏在哪张图上就放大哪一张，其余的不动 */
    target: (e) => {
      const a = e.touches[0];
      const b = e.touches[1];
      const mid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
      const el = document.elementFromPoint(mid.x, mid.y);
      return el?.closest('.reader__item')?.querySelector<HTMLElement>('.reader__page') ?? null;
    },
    enabled: !hudVisible,
    /* 滚动模式不管平移：放大后原生滚动就能拖着看 */
    clampPan: false,
    resetKey: images,
    resetToken,
    apply,
    onZoomedChange,
  });

  /*
   * "停在章末后又往下推了一下"的两种形状：滚轮一格、手指一次新的拖动。
   *
   * 触摸这边只认**一次新手势**：一路滑到底的那只手，尾巴上还会挤进来几个
   * touchmove，全算成第二次意图的话，第一段"停在章末"就白留了。
   * 所以 touchstart 才把闸重新打开，一次手势最多报一次。
   *
   * 都是 passive 的：我们不拦原生行为，只是把意图报上去。
   */
  useEffect(() => {
    const el = box.current;
    if (!el || !onPullDown) return;
    let freshGesture = false;
    let lastY = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY > 0) onPullDown();
    };
    const onTouchStart = (e: TouchEvent) => {
      freshGesture = true;
      lastY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!freshGesture) return;
      const y = e.touches[0]?.clientY ?? 0;
      // 手指往上移 = 内容往下走
      if (lastY - y > 24) {
        freshGesture = false;
        onPullDown();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, [box, onPullDown, images]);

  return (
    <div
      className={zoomed ? 'reader__scroll is-zoomed' : 'reader__scroll'}
      ref={box}
      /*
       * 拦下浏览器自己的双指缩放（它放大的是整个文档，菜单和进度条会跟着一起糊），
       * 双指交给我们自己。pan-x pan-y 只放开拖动滚动，不留 pinch-zoom。
       */
      style={{ filter, touchAction: 'pan-x pan-y' }}
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
      {/*
       * 章末那一行。平时是静态的「— 本章完 —」；停在章末且自动下一章开着时
       * 换成可点的一行，把"再推一下"这件事说在眼前，同时也真能点。
       */}
      {endHint ? (
        <button
          className="reader__end reader__end--go"
          onClick={(e) => {
            e.stopPropagation();
            onEndTap?.();
          }}
        >
          {endHint}
        </button>
      ) : (
        <div className="reader__end">— 本章完 —</div>
      )}
    </div>
  );
}
