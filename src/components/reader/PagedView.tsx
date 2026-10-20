import { useCallback, useEffect, useRef, useState } from 'react';
import { PagedCells } from './PagedCells';
import { usePagedGesture } from './usePagedGesture';
import { usePinchZoom } from './usePinchZoom';
import { warmImages } from '@/reader/warmImages';
import type { TurnAnim } from '@/reader/prefs';

/** 演翻页前最多等解码等多久。超了也照演，手势反馈不能拖 */
const WARM_MS = 90;

/**
 * 单击要等这么久才执行，用来分辨双击。
 *
 * 为什么不能不做：点击区盖在图片上面，双击放大挂在图片上永远收不到事件。
 * 唯一可靠的做法是把单击压后一个双击窗口；代价是点击翻页慢 220ms
 * （键盘和滑动不受影响）。220ms 是常见双击阈值，再长翻页会明显发黏。
 */
const TAP_DELAY_MS = 220;
/** 两次点击落点差这么多以内才算双击 */
const DOUBLE_TAP_SLOP = 28;

/** 一个槽位里放的内容 */
interface Screen {
  images: string[];
  startIndex: number;
}
/** 一次正在演的翻页：谁抬起、谁被露出 */
interface Turn {
  from: number;
  to: number;
  forward: boolean;
}

/**
 * 分页视图：一屏一页或两页，适合平板和显示器。
 *
 * 翻页有两种输入，必须走同一套方向语义：
 *   - 点击左右区域（tap 区）
 *   - 横向滑动（手机上更自然，之前完全没做）
 * rtl 时两者都反过来：点左/向右滑 = 前进。
 *
 * **双缓冲**：两个常驻槽位轮流当台面上的那一页，谁都不重建。
 * 前两版都是"当前页 + 一个临时覆盖层"的结构，无论怎么排，总有一页的 <img>
 * 要在翻页那一刻被 React 销毁重建一次（第一版重建结尾、第二版重建开头），
 * 新节点即使命中缓存也要重新挂、重新解码 —— 那就是用户看到的闪。
 * 槽位固定之后，翻页只是"给两个常驻节点换个 class"，DOM 一个都不新建。
 */
export default function PagedView({
  images,
  startIndex,
  perPage,
  markedPages,
  filter,
  enhance,
  rtl,
  anim,
  turnKey,
  hudVisible,
  resetToken,
  onTapZone,
  onSwipe,
  onZoom,
  onZoomedChange,
  edgeHint,
}: {
  /** 当前屏要显示的图片（已按 perPage 切好） */
  images: string[];
  /** 当前屏第一张在整个章节里的序号 */
  startIndex: number;
  perPage: number;
  markedPages: Set<number>;
  filter?: string;
  /** 画面增强（实验） */
  enhance?: boolean;
  /** 右起阅读：双页时左右要互换，滑动方向也要反过来 */
  rtl: boolean;
  /** 翻页动画演哪一档：无 / 平移 / 翻页 */
  anim: TurnAnim;
  /** 换章时变一下。翻页动画只在同一章内演 —— 跨章不该有"上一页" */
  turnKey: string;
  /** 顶部菜单展开中：不收双指手势，已放大的顺手还原 */
  hudVisible: boolean;
  /** 变一次还原一次：右下角那颗按钮 */
  resetToken: number;
  onTapZone: (side: 'left' | 'right' | 'center') => void;
  onSwipe: (dir: 'forward' | 'back') => void;
  onZoom: (src: string, index: number) => void;
  /** 放大态变了要说给外面 —— 右下角那颗还原按钮跟着出现 */
  onZoomedChange: (zoomed: boolean) => void;
  edgeHint: React.ReactNode;
}) {
  const [slots, setSlots] = useState<[Screen, Screen]>(() => [
    { images, startIndex },
    { images: [], startIndex: -1 },
  ]);
  const [active, setActive] = useState(0);
  const [turn, setTurn] = useState<Turn | null>(null);
  /** 内容已经写进槽位、正在等解码的那一次翻页 */
  const [armed, setArmed] = useState<{ slot: number; forward: boolean } | null>(null);
  /** 适应宽度时一页比屏幕高：先提示一次「上下滚动」，别让人以为下半截丢了 */
  const [scrollHint, setScrollHint] = useState(false);
  /** 每章只提示一次；每翻一页都弹一次会变成噪音 */
  const hintedScrolling = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);
  const shown = useRef({ images, startIndex, turnKey });

  /*
   * 双指放大。缩放作用在当前台面那一层 spread 上，用 transform 而不是改尺寸：
   * 图片的显示尺寸是 object-fit 四档适配算出来的，只有 transform 能叠在它上面。
   */
  const apply = useCallback((el: HTMLElement, s: { scale: number; x: number; y: number }) => {
    el.style.transform = s.scale > 1 ? `translate(${s.x}px, ${s.y}px) scale(${s.scale})` : '';
    el.style.willChange = s.scale > 1 ? 'transform' : '';
  }, []);

  const { zoomed } = usePinchZoom({
    container: stageRef,
    /* 一屏就一张（双页时两张并排），放大的是整屏，不用挑元素 */
    target: () => slotRefs.current[active] ?? null,
    enabled: !hudVisible,
    clampPan: true,
    /* 换屏、换章都归位：放大是"看这一屏的细节"，跳到下一屏它就没意义了 */
    resetKey: `${turnKey}:${startIndex}:${resetToken}`,
    apply,
    onZoomedChange,
  });

  const { onTouchStart, onTouchEnd, tap, takeSwipe } = usePagedGesture({
    rtl,
    /* 放大后横向拖动是平移着看，不是翻页 */
    enabled: !zoomed,
    onSwipe,
    /*
     * 放大态下左右两块不翻页：在一张放大的图上点一下就跳走，人还没看完。
     * 中间那块照旧 —— 点它是开菜单，菜单一开就顺手还原，等于给放大态留了个出口。
     */
    onTapZone: zoomed
      ? (side) => {
          if (side === 'center') onTapZone(side);
        }
      : onTapZone,
  });

  /* ── 双击 / 长按放大 ── */

  /*
   * 延迟执行的单击要拿「到点时最新」的那份手势。
   * 直接捕获 render 时的 tap 的话，这 220ms 里若切了放大态/换了一屏，
   * 触发时用的还是旧闭包（比如放大后仍然把侧边点击当成翻页）。
   */
  const tapRef = useRef(tap);
  tapRef.current = tap;

  /** 最近一次单击（还没执行的那一下），用来判断下一击是不是双击 */
  const lastTap = useRef<{ x: number; y: number; at: number } | null>(null);
  /** 最近一次单击的定时器；更早的那些也都要在卸载时清掉 */
  const tapTimer = useRef<number | null>(null);
  const tapTimers = useRef<Set<number>>(new Set());

  useEffect(
    () => () => {
      for (const t of tapTimers.current) window.clearTimeout(t);
      tapTimers.current.clear();
      tapTimer.current = null;
      lastTap.current = null;
    },
    [],
  );

  /*
   * 适应宽度时一页通常比视口高。页码只说「第几页」，看不出上下还有内容；
   * 进新一屏时给一句短提示，滚动或 3 秒后自己消失。
   */
  useEffect(() => {
    hintedScrolling.current = false;
  }, [turnKey]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const check = () => {
      const tall = el.scrollHeight > el.clientHeight + 4;
      if (!tall || hintedScrolling.current) return;
      hintedScrolling.current = true;
      setScrollHint(true);
    };
    const raf = requestAnimationFrame(check);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const canvas = el.querySelector('.reader__paged-canvas');
    if (canvas) ro.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [startIndex, turnKey, perPage]);

  /*
   * 自动隐藏必须单独一条 effect。
   *
   * 以前计时器挂在上面那条 effect 里：切模式/换屏让它重跑时 cleanup 会清掉计时器，
   * 而 hintedScrolling 已经是 true，新的一轮不会再设计时器 —— 提示就永远挂在那里
   * （滚动模式切到翻页模式后最明显）。现在计时器只跟 scrollHint 本身绑定，
   * 上面那条 effect 怎么重跑都不影响它。
   */
  useEffect(() => {
    if (!scrollHint) return;
    const timer = window.setTimeout(() => setScrollHint(false), 3000);
    return () => window.clearTimeout(timer);
  }, [scrollHint]);

  /**
   * 在 (x,y) 底下那一页上打开放大层。
   *
   * 点击区盖在图片上，所以不能靠 event.target 找图：自己拿当前台面那层的
   * 图片矩形去命中。双页时两张图都在 DOM 里，顺序就是 images 的顺序
   * （右起只是 row-reverse，没有重排数组）。
   */
  const zoomAtPoint = useCallback(
    (x: number, y: number) => {
      if (zoomed) return;
      const slot = slots[active];
      const el = slotRefs.current[active];
      if (!slot || !el) return;

      const imgs = Array.from(el.querySelectorAll('img'));
      let idx = -1;
      for (let i = 0; i < imgs.length; i++) {
        const r = imgs[i].getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          idx = i;
          break;
        }
      }
      /* 点在图片外的留白上：取水平方向最近的那张，别让双击落空 */
      if (idx < 0) {
        let best = Infinity;
        for (let i = 0; i < imgs.length; i++) {
          const r = imgs[i].getBoundingClientRect();
          const d = Math.abs((r.left + r.right) / 2 - x);
          if (d < best) {
            best = d;
            idx = i;
          }
        }
      }

      const src = slot.images[idx];
      if (src) onZoom(src, slot.startIndex + idx);
    },
    [active, onZoom, slots, zoomed],
  );

  /**
   * 点区的单击：先压一个双击窗口，再按原样交给手势层。
   *
   * 滑动带出来的补点击要先被 takeSwipe 认领掉 —— 否则它会成为双击的第一下，
   * 下一下正常点击就被误判成放大。
   */
  const handleZoneClick = (
    side: 'left' | 'right' | 'center',
    e: React.MouseEvent,
  ) => {
    if (takeSwipe()) return;

    const now = performance.now();
    const prev = lastTap.current;
    if (
      prev &&
      now - prev.at <= TAP_DELAY_MS &&
      Math.hypot(e.clientX - prev.x, e.clientY - prev.y) <= DOUBLE_TAP_SLOP
    ) {
      if (tapTimer.current !== null) {
        window.clearTimeout(tapTimer.current);
        tapTimers.current.delete(tapTimer.current);
        tapTimer.current = null;
      }
      lastTap.current = null;
      zoomAtPoint(e.clientX, e.clientY);
      return;
    }

    const timer = window.setTimeout(() => {
      tapTimers.current.delete(timer);
      if (tapTimer.current === timer) {
        tapTimer.current = null;
        lastTap.current = null;
      }
      tapRef.current(side);
    }, TAP_DELAY_MS);

    tapTimers.current.add(timer);
    tapTimer.current = timer;
    lastTap.current = { x: e.clientX, y: e.clientY, at: now };
  };

  /** 右击 / 安卓长按：和滚动模式一样直接开放大层，不走双击窗口 */
  const handleZoneMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    zoomAtPoint(e.clientX, e.clientY);
  };

  const leftLabel = rtl ? '下一页' : '上一页';
  const rightLabel = rtl ? '上一页' : '下一页';

  useEffect(() => {
    const prev = shown.current;
    shown.current = { images, startIndex, turnKey };

    /*
     * 「这一屏有没有变」必须按值比，不能比数组。
     *
     * 上游是 images.slice(...)，父组件每一次重渲染都交来一个新数组，
     * 引用相等永远不成立 —— 之前就是这个坑：点中间（只开关悬浮件，页码没动）
     * 也会走到下面"换槽 + 演一次"的分支，屏幕上凭空落下一张重复的页；
     * 翻页演到一半时若父组件重渲染（进度、偏好、章节加载），
     * 半路的动画会被一个新的反向动画顶掉，看着就是一顿一闪。
     *
     * 站位（startIndex）才是"换没换屏"的准信，图片数组只用来判断内容要不要刷新：
     * 章节里出现两张一样的图时，光比数组会把真翻页误判成没翻。
     */
    if (prev.turnKey === turnKey && prev.startIndex === startIndex) {
      if (!sameScreen(prev.images, images)) {
        setSlots((s) => writeSlot(s, active, { images, startIndex }));
      }
      return;
    }

    /*
     * 换章（turnKey 变）、首帧、或者一步跨了很多屏（打开时恢复到上次看到的那一页）：
     * 直接落在台面上，不演 —— 只有正常步幅的换屏才是一次真实的翻页，
     * 跨章和回位都没有"上一页"，硬掀一下莫名其妙。
     */
    const step = Math.abs(startIndex - prev.startIndex);
    if (prev.turnKey !== turnKey || prev.images.length === 0 || step > perPage) {
      setSlots((s) => writeSlot(s, active, { images, startIndex }));
      setTurn(null);
      setArmed(null);
      return;
    }

    /*
     * 上一次还演到一半就又来了新屏（连点、快滑）：把这一次翻页直接掐掉、
     * 新屏平着落在台面上，不演。
     *
     * 不能让它去顶掉半路的动画 —— 那等于往一张正在掀起的纸上换内容，
     * 纸上会突然蹦出另一页。连点的时候用户要的是"快"，不是一次完整的翻页。
     */
    if (turn) {
      setTurn(null);
      setArmed(null);
      setSlots((s) => writeSlot(s, active, { images, startIndex }));
      return;
    }

    /*
     * 内容先写进那个还没露面的槽位，等它把图解好码再换台面、开始演。
     * 中间这几帧屏幕上还是原来那一页，什么也不会露。
     */
    const next = 1 - active;
    setSlots((s) => writeSlot(s, next, { images, startIndex }));
    setArmed({ slot: next, forward: startIndex > prev.startIndex });
  }, [images, startIndex, turnKey, active, turn]);

  useEffect(() => {
    if (!armed) return;
    let live = true;
    void warmImages(slotRefs.current[armed.slot], WARM_MS).then(() => {
      if (!live) return;
      /*
       * 「无」这一档仍然要先等解码再换台面 —— 那一层等待是为了不露空白，
       * 和演不演动画是两回事。只是换完台面之后不再挂动画 class。
       */
      setActive(armed.slot);
      setTurn(anim === 'none' ? null : { from: 1 - armed.slot, to: armed.slot, forward: armed.forward });
      setArmed(null);
    });
    return () => {
      live = false;
    };
  }, [armed, anim]);

  /*
   * 这一次翻页的动画参数。
   *
   * **翻页（折页）**：书脊在哪边就绕哪条边折 —— 左起书脊在左、右起在右。
   * 转到 ±90° 而不是 72°：纸页侧立时宽度为零，撤掉它没有跳变；停在 72° 的话，
   * 撤掉那一帧还剩一条边，看着就是又闪一下。
   *
   * **平移（推动式）**：两页同向同速横移，谁都不盖谁。往哪边推由「方向 × 前进/回退」
   * 决定，在 JS 里算成一个 CSS 变量，样式表只管按它移动 ——  rtl 的镜像不该散在两处。
   */
  const turnStyle = (() => {
    if (!turn) return {} as React.CSSProperties;
    if (anim === 'slide') {
      /* 往前翻：ltr 时旧页往左出画、新页从右边进来；rtl 整个反过来 */
      const leaveTo = turn.forward !== rtl ? '-100%' : '100%';
      return {
        '--slide-leave-to': leaveTo,
        '--slide-enter-from': leaveTo === '-100%' ? '100%' : '-100%',
      } as React.CSSProperties;
    }
    return {
      '--turn-origin': rtl ? 'right center' : 'left center',
      '--turn-to': `${rtl ? 90 : -90}deg`,
      '--turn-shade-dir': rtl ? 'to right' : 'to left',
      // 被露出的那一页从反方向轻微移进来：两层一起动，看着才像同一次物理事件
      '--turn-parallax': `${rtl ? 10 : -10}px`,
    } as React.CSSProperties;
  })();

  const spreadClass = (extra: string) =>
    `reader__spread${extra}${perPage === 2 ? ' is-double' : ''}${rtl && perPage === 2 ? ' is-rtl' : ''}`;

  /* 抬起的那一层：往前翻是旧页，往后翻是新页。另一层在底下被露出来 */
  const overIdx = turn ? (turn.forward ? turn.from : turn.to) : -1;
  const underIdx = turn ? (turn.forward ? turn.to : turn.from) : -1;

  /**
   * 这一层在这次翻页里演什么。
   *
   * 折页只有上面那张在转，底下那张由样式表的视差规则带着挪一点 —— 所以只有 it 需要 class。
   * 平移是两页一起走，谁离场谁进场由 from/to 定，跟叠放次序无关。
   */
  const animClass = (i: number) => {
    if (!turn) return '';
    if (anim === 'flip') return i === overIdx ? (turn.forward ? ' turn-out' : ' turn-in') : '';
    return i === turn.from ? ' slide-leave' : i === turn.to ? ' slide-enter' : '';
  };

  /*
   * 暗面/投影的 animationend 会从子元素冒泡上来，只认演翻页那一层自己的。
   * 认错了会在动画演到一半时把上一页撤掉，留下半张纸的跳变。
   */
  const endTurn = (e: React.AnimationEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    setTurn(null);
  };

  return (
    <div
      className="reader__paged"
      ref={stageRef}
      data-anim={anim}
      data-turn={turn ? (turn.forward ? 'fwd' : 'back') : undefined}
      /*
       * 平时只放开上下滚（适应宽度那一档图会比屏高）；放大之后一根手指是平移，
       * 再放开滚动的话拖两下人就跑出这一屏了。
       * 双指缩放本身靠 usePinchZoom 里的原生监听 + preventDefault 接管，
       * 这里不写 pinch-zoom 就是在告诉浏览器：这一片的整页缩放别插手。
       */
      style={{ filter, touchAction: zoomed ? 'none' : 'pan-y' }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onScroll={() => scrollHint && setScrollHint(false)}
    >
      {/*
        内层画布跟着内容长高，点击区才有内容可盖。
        点击区如果直接挂在滚动容器上，top:0/bottom:0 量的是**可视框**而不是滚动内容：
        往下滚一屏，三段点击区就整块滚出视口，人只能滚回顶部才点得到（实测复现过）。
      */}
      <div className="reader__paged-canvas">
        {/*
          双页时 rtl 用 row-reverse 而不是重排数组：DOM 顺序保持原样，
          startIndex + i 算出的绝对页号才不会错，书签标记和 alt 也就不会错位。
        */}
        {slots.map((s, i) => {
          const isOver = i === overIdx;
          const isUnder = i === underIdx;
          const cls = spreadClass(
            `${isOver ? ' is-over' : isUnder ? ' is-under' : i === active ? '' : ' is-hidden'}${animClass(i)}`,
          );
          return (
            <div
              key={i}
              ref={(el) => {
                slotRefs.current[i] = el;
              }}
              className={cls}
              style={isOver || isUnder ? turnStyle : undefined}
              onAnimationEnd={isOver ? endTurn : undefined}
            >
              <PagedCells
                list={s.images}
                base={s.startIndex}
                markedPages={markedPages}
                enhance={enhance}
                onZoom={onZoom}
              />
              {/* 纸的暗面和投影只属于折页；平移是两张平面在走，套上去就成了脏影 */}
              {isOver && anim === 'flip' && <div className="reader__turn-shade" aria-hidden="true" />}
              {isUnder && anim === 'flip' && <div className="reader__turn-cast" aria-hidden="true" />}
            </div>
          );
        })}

        {/*
          点击区三段划分：左右各 32% 翻页，中间 36% 只切工具栏。
          中间留这么宽是为了避免「想看工具栏却翻页了」这种误触 ——
          这是实测里最影响阅读体验的问题。
        */}
        {/*
         * 单击统一走 handleZoneClick（压一个双击窗口）；双击/右击/长按都在
         * 这里放开大层。role/aria 是给读屏用的：它们没有 tabIndex，
         * 键盘仍是既有的方向键，不会多出三个 Tab 停靠点。
         */}
        <div
          className="paged-tap paged-tap--l"
          role="button"
          tabIndex={-1}
          aria-label={leftLabel}
          onClick={(e) => handleZoneClick('left', e)}
          onContextMenu={handleZoneMenu}
        />
        <div
          className="paged-tap paged-tap--r"
          role="button"
          tabIndex={-1}
          aria-label={rightLabel}
          onClick={(e) => handleZoneClick('right', e)}
          onContextMenu={handleZoneMenu}
        />
        <div
          className="paged-tap paged-tap--c"
          role="button"
          tabIndex={-1}
          aria-label="显示或隐藏工具栏"
          onClick={(e) => handleZoneClick('center', e)}
          onContextMenu={handleZoneMenu}
        />
      </div>

      {scrollHint && (
        <div className="reader__scroll-hint" role="status">
          上下滚动看完整页
        </div>
      )}
      {edgeHint}
    </div>
  );
}

/** 换一个槽位的内容。整份数组要新建，否则 React 认为没变 */
function writeSlot(slots: [Screen, Screen], i: number, s: Screen): [Screen, Screen] {
  const next: [Screen, Screen] = i === 0 ? [s, slots[1]] : [slots[0], s];
  return next;
}

/** 一屏的图片内容是否没变。一屏最多两张，逐项比不贵 */
function sameScreen(a: string[], b: string[]) {
  return a.length === b.length && a.every((src, i) => src === b[i]);
}
