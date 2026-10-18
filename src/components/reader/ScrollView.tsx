import { useCallback, useEffect, useRef } from 'react';
import { PageImage } from './PageImage';
import { IconBookmark } from '@/components/Icons';
import ProgressRing from '@/components/ProgressRing';
import { usePinchZoom, type PinchState } from './usePinchZoom';

/** 竖向滚动视图：连续下滑，适合手机和长章节 */
export default function ScrollView({
  images,
  markedPages,
  filter,
  enhance,
  containerRef,
  hudVisible,
  resetToken,
  onScroll,
  onTap,
  onZoom,
  onZoomedChange,
  onPullStart,
  onPullHold,
  endHint,
  pull = 0,
  onEndTap,
}: {
  images: string[];
  markedPages: Set<number>;
  filter?: string;
  /** 画面增强（实验）。开着时每张页会另算一版按屏幕宽度的重采样 + 补锐 */
  enhance?: boolean;
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
   * 停在章末后又往下推 / 按住不放。这里只报意图，攒不攒、攒多快、
   * 什么时候算满，全在 useAutoNextChapter 判。
   * onPullHold(false) 是"手离开了" —— 蓄到一半的力要能退回去。
   */
  onPullStart?: () => void;
  onPullHold?: (on: boolean) => void;
  /** 章末那一行的提示文案。给了它，那一行就变成带环的可点行 */
  endHint?: string | null;
  /** 0–1，那一圈环按它画 */
  pull?: number;
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
   * 停在章末时的"还在拉"这件事，两种输入两种形状：
   *  - 手指：按下去算开始，抬起来算结束。中间就算一动不动也一直在拉
   *    （到底之后原地按着手指数得到秒，靠的是状态机那边按时间攒，不是 touchmove）。
   *  - 滚轮：没有"松手"这回事，所以每一下都报一次"还在推"，多久没动静算停手 ——
   *    那条超时在状态机里（WHEEL_HOLD_MS）。
   *
   * 双指捏合不算上拉：只认一根手指。监听全 passive，我们不改原生滚动，
   * 只是把意图报上去。
   */
  useEffect(() => {
    const el = box.current;
    if (!el || (!onPullStart && !onPullHold)) return;
    const oneFinger = (e: TouchEvent) => e.touches.length === 1 && !e.touches[1];
    const onStart = (e: TouchEvent) => {
      if (oneFinger(e)) {
        onPullStart?.();
        onPullHold?.(true);
      }
    };
    const onEnd = () => onPullHold?.(false);
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY > 0) onPullStart?.();
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('wheel', onWheel);
    };
  }, [box, onPullStart, onPullHold, images]);

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
          <PageImage
            className="reader__page"
            src={src}
            alt={`第 ${i + 1} 页`}
            eager={i < 3}
            enhance={enhance}
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
       * 换成带环的一行 —— 环就是"还要拉多久"的那点余量，松手它会退回去。
       */}
      {endHint ? (
        <button
          className="reader__end reader__end--go"
          onClick={(e) => {
            e.stopPropagation();
            onEndTap?.();
          }}
        >
          {/* 环只画"还差多少"，那句话已经写在旁边了 —— 别再给环一个同名无障碍名 */}
          <ProgressRing percent={pull * 100} size={20} label="蓄力" decorative />
          <span>{endHint}</span>
        </button>
      ) : (
        <div className="reader__end">— 本章完 —</div>
      )}
    </div>
  );
}
