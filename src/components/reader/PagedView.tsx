import { useEffect, useRef, useState } from 'react';
import { PagedCells } from './PagedCells';
import { usePagedGesture } from './usePagedGesture';
import { warmImages } from '@/reader/warmImages';
import type { TurnAnim } from '@/reader/prefs';

/** 演翻页前最多等解码等多久。超了也照演，手势反馈不能拖 */
const WARM_MS = 90;

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
  rtl,
  anim,
  turnKey,
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
  /** 翻页动画演哪一档：无 / 平移 / 翻页 */
  anim: TurnAnim;
  /** 换章时变一下。翻页动画只在同一章内演 —— 跨章不该有"上一页" */
  turnKey: string;
  onTapZone: (side: 'left' | 'right' | 'center') => void;
  onSwipe: (dir: 'forward' | 'back') => void;
  onZoom: (src: string, index: number) => void;
  edgeHint: React.ReactNode;
}) {
  const { onTouchStart, onTouchEnd, tap } = usePagedGesture({ rtl, onSwipe, onTapZone });

  const [slots, setSlots] = useState<[Screen, Screen]>(() => [
    { images, startIndex },
    { images: [], startIndex: -1 },
  ]);
  const [active, setActive] = useState(0);
  const [turn, setTurn] = useState<Turn | null>(null);
  /** 内容已经写进槽位、正在等解码的那一次翻页 */
  const [armed, setArmed] = useState<{ slot: number; forward: boolean } | null>(null);
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);
  const shown = useRef({ images, startIndex, turnKey });

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
      data-anim={anim}
      data-turn={turn ? (turn.forward ? 'fwd' : 'back') : undefined}
      style={{ filter, touchAction: 'pan-y' }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
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
            <PagedCells list={s.images} base={s.startIndex} markedPages={markedPages} onZoom={onZoom} />
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
      <div className="paged-tap paged-tap--l" onClick={() => tap('left')} />
      <div className="paged-tap paged-tap--r" onClick={() => tap('right')} />
      <div className="paged-tap paged-tap--c" onClick={() => tap('center')} />

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
