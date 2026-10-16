import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * 书架长按拖拽排序
 *
 * 这一版是照着"用户能不能预知结果"重做的，不是上一版的修补：
 *
 * 1. **原卡片留在流里当那个虚线格子，跟着手指的是它的克隆。**
 *    上一版把原元素用 translate 拖着走 —— 偏移量是相对它自己的**布局位置**算的，
 *    列表一换位它的布局位置就变了，同一个偏移直接把它甩到屏幕外（实测 x=513，视口才 390）。
 *    现在原元素只负责占位（尺寸天然和卡片一致，不用另算占位框多高），
 *    克隆体是 fixed 的，"它的布局位置"根本不存在，这一整类错位一次性消失。
 * 2. **让出来的位置画成虚线框**，拖动中其余格子各描一圈淡虚线 ——
 *    用户要能看见"松手它会落在哪"，而不是靠猜。
 * 3. **落位有动画**：松手后克隆体从手指位置飞进虚线框。
 *    少了这一步，卡片会"消失一下又出现"，用户以为拖丢了。
 * 4. 触屏长按 400ms 才起拖（在那之前页面照常能滚），鼠标按住移动几像素直接起拖。
 * 5. 拖到视口上下边缘自动滚屏，长书架能拖到底。
 * 6. 抬手后浏览器会补一发 click，而卡片是 <a>，不截掉就会顺手跳进详情页。
 */

/** 触屏长按到这个点才进入拖拽 —— 比这早的移动都当成用户想滚动 */
const LONG_PRESS_MS = 400;
/** 长按没到就移动超过这个量：判定为滚动，取消拖拽 */
const CANCEL_PX = 12;
/** 鼠标：按下后移动这么多像素就起拖 */
const MOUSE_START_PX = 6;
/** 距视口上下边缘这么多像素内时自动滚屏 */
const EDGE_PX = 56;
const EDGE_SCROLL_PX = 10;
/** 让位动画。手指比眼睛快，跟不上就成闪烁 */
const FLIP_MS = 200;

/**
 * 布局坐标（文档系），**不受 transform 影响**。
 *
 * 不能用 getBoundingClientRect：它会把正在播放的让位动画的中间态一起量进来。
 * 上一版就是这么坏的 —— 记下的"之前"位置其实是动画半路的坐标，下一帧元素回到
 * 真位置，差值又被当成一次新的让位动画放出去，于是自己放大自己：
 * 表现为背景卡片鬼畜乱飘，以及松手时凭空多出来的那一下移动。
 */
function layoutRect(el: HTMLElement) {
  let left = 0;
  let top = 0;
  for (let node: HTMLElement | null = el; node; node = node.offsetParent as HTMLElement | null) {
    left += node.offsetLeft;
    top += node.offsetTop;
  }
  return { left, top, width: el.offsetWidth, height: el.offsetHeight };
}

export interface ShelfDrag {
  /** 当前正在拖的卡片 key；没在拖是 null。原元素据此画成虚线格子 */
  dragKey: string | null;
  /** 完整视觉顺序（被拖那张就落在它应在的位置上）。松手就提交它 */
  order: string[];
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
}

interface Session {
  key: string;
  /** 留在流里占位的那张原卡片 */
  el: HTMLElement;
  /** 跟着手指走的克隆 */
  ghost: HTMLElement | null;
  /** 起拖时手指按在卡片内的哪一点，之后一直保住这个相对位置 */
  grabX: number;
  grabY: number;
  startX: number;
  startY: number;
  pointerId: number;
  timer: number;
  active: boolean;
  /** 落位动画进行中 */
  dropping: boolean;
  /**
   * 起拖那一刻整个网格的格子坐标（**文档坐标**，已加过滚动量）。
   *
   * 判定只能对着这份快照算。上一版每帧去量实时 DOM 矩形，可让位之后矩形本身就变了，
   * 于是"最近的格子"在两个值之间反复横跳 —— 用户看到的就是背景卡片鬼畜乱飘。
   * 网格的行列在拖动中不会变（列数是定的、格子数没增减），所以这份快照一直是准的。
   */
  lattice: { left: number; top: number; width: number; height: number }[];
}

export function useShelfDrag(args: {
  keys: string[];
  /** false 时整套交互不挂（自动排法下手拽的结果会被规则盖掉，那是骗人） */
  enabled: boolean;
  onCommit: (keys: string[]) => void;
}): ShelfDrag {
  const { keys, enabled, onCommit } = args;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [order, setOrder] = useState<string[]>(keys);
  const [dragKey, setDragKey] = useState<string | null>(null);

  const session = useRef<Session | null>(null);
  /** 上一次测量到的位置，FLIP 的 First */
  const rects = useRef<Map<string, ReturnType<typeof layoutRect>>>(new Map());
  const liveOrder = useRef<string[]>(keys);
  /** 当前插入位。moveTo 每帧都跑，读 state 会拿到旧值 */
  const atRef = useRef(0);

  /* 外部顺序变了（提交后重读、同步写回、换排序方式）且没在拖，就跟外部对齐 */
  useEffect(() => {
    if (dragKey) return;
    const same =
      keys.length === liveOrder.current.length && keys.every((k, i) => k === liveOrder.current[i]);
    if (same) return;
    liveOrder.current = keys;
    setOrder(keys);
  }, [keys, dragKey]);

  /** 让位动画：量出每个格子移动前后的差，先反向平移再放归。虚线格子也参与 —— 它本来就该滑 */
  useLayoutEffect(() => {
    const box = containerRef.current;
    if (!box) return;
    const prev = rects.current;
    const next = new Map<string, ReturnType<typeof layoutRect>>();

    for (const el of Array.from(box.querySelectorAll<HTMLElement>('[data-key]'))) {
      const key = el.dataset.key as string;
      const rect = layoutRect(el);
      next.set(key, rect);
      const before = prev.get(key);
      if (!before) continue;
      const dx = before.left - rect.left;
      const dy = before.top - rect.top;
      if (!dx && !dy) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: FLIP_MS,
        easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
      });
    }
    rects.current = next;
  }, [order, dragKey]);

  /**
   * 收尾：克隆体直接消失，卡片就落在虚线格子那里。
   *
   * 原来这里演了一段"从手指飞回格子"，用户明确不要 —— 位置是**拖的过程中**
   * 就已经摆好的，松手只是确认，再飞一次等于把已经做完的事重做一遍，看着像卡了一下。
   */
  const settle = useCallback(
    (s: Session, commit: boolean) => {
      s.ghost?.remove();
      s.ghost = null;
      const box = containerRef.current;
      if (box) box.style.touchAction = '';
      setDragKey(null);
      if (commit) onCommit(liveOrder.current);
    },
    [onCommit],
  );

  const finish = useCallback(
    (commit: boolean) => {
      const s = session.current;
      session.current = null;
      if (!s) return;
      if (s.timer) window.clearTimeout(s.timer);
      if (!s.active || s.dropping) return;
      s.dropping = true;
      /*
       * 抬手一定会补一发 click（触屏尤其）。卡片是 <a>，不截掉就是"拖完顺手进详情页"。
       * 用捕获阶段的一次性监听器吃掉它。
       */
      const swallow = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        window.removeEventListener('click', swallow, true);
      };
      window.addEventListener('click', swallow, true);
      window.setTimeout(() => window.removeEventListener('click', swallow, true), 500);
      settle(s, commit);
    },
    [settle],
  );

  /** 抬起卡片的中点落在哪个格子，就插到那个位置 */
  const moveTo = useCallback((x: number, y: number) => {
    const s = session.current;
    if (!s?.ghost || !s.lattice.length) return;

    /*
     * 探针用**抬起卡片的中点**，不是手指点：手指可以按在卡片任意位置，
     * 拿它当判据会出现"明明整个盖住对方了还不换"（用户的第一条抱怨）。
     * 再叠上原来"必须越过对方中心"的半步要求，迟钝感翻倍 —— 现在改成
     * 中点进到哪一格就换到哪一格，一格一格清清楚楚。
     */
    // 克隆体是 fixed，视口坐标 = 指针 - 抓握偏移；换算到文档坐标再和格子比
    const px = x - s.grabX + s.ghost.offsetWidth / 2 + window.scrollX;
    const py = y - s.grabY + s.ghost.offsetHeight / 2 + window.scrollY;

    let next = -1;
    for (let i = 0; i < s.lattice.length; i++) {
      const c = s.lattice[i];
      if (px >= c.left && px <= c.left + c.width && py >= c.top && py <= c.top + c.height) {
        next = i;
        break;
      }
    }
    if (next < 0) {
      // 拖到网格外面（下方空白、边缘滚屏时）：贴着最近的那一格，别让它没有落点
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < s.lattice.length; i++) {
        const c = s.lattice[i];
        const d = Math.hypot(px - (c.left + c.width / 2), py - (c.top + c.height / 2));
        if (d < best) {
          best = d;
          next = i;
        }
      }
    }
    if (next < 0 || next === atRef.current) return;
    atRef.current = next;
    const flow = liveOrder.current.filter((k) => k !== s.key);
    flow.splice(Math.min(next, flow.length), 0, s.key);
    liveOrder.current = flow;
    setOrder(flow);
  }, []);

  useEffect(() => {
    const box = containerRef.current;
    if (!box || !enabled) return;

    const place = (s: Session, x: number, y: number) => {
      if (!s.ghost) return;
      s.ghost.style.left = `${x - s.grabX}px`;
      s.ghost.style.top = `${y - s.grabY}px`;
    };

    const lift = (s: Session, x: number, y: number) => {
      if (session.current !== s || s.active) return;
      const r = s.el.getBoundingClientRect();
      s.grabX = x - r.left;
      s.grabY = y - r.top;
      s.active = true;

      /*
       * 克隆体挂在 body 上而不是网格里：grid 会去排它，fixed 才不受父级影响。
       * pointer-events:none 是必须的 —— 否则它挡在手指下面，后面的 move 全落到它身上。
       */
      const ghost = s.el.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('data-key');
      ghost.removeAttribute('href');
      ghost.className = 'card card--plate card--dragging';
      ghost.style.width = `${r.width}px`;
      ghost.style.height = `${r.height}px`;
      ghost.style.left = `${r.left}px`;
      ghost.style.top = `${r.top}px`;
      document.body.appendChild(ghost);
      s.ghost = ghost;
      /*
       * 快照要连被拖那张自己那一格一起存：它的格子就是"还放回原处"这个选项。
       * 存文档坐标 —— 拖动中会自动滚屏，视口坐标会跟着漂。
       */
      s.lattice = Array.from(box.querySelectorAll<HTMLElement>('[data-key]')).map((el) => layoutRect(el));

      /*
       * 这一行管不到当前这一次手势 —— touch-action 是在 touchstart 那一刻定下来的，
       * 手指已经按了 400ms 之后再改，浏览器不认。真正掐住滚动的是下面那个
       * touchmove 的 preventDefault。留着它是为了下一次落指就不给滚。
       */
      box.style.touchAction = 'none';
      atRef.current = Math.max(0, liveOrder.current.indexOf(s.key));
      setDragKey(s.key);
      navigator.vibrate?.(8);
      ghost.animate([{ opacity: 0.85 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
      if (!card || !box.contains(card)) return;
      const s: Session = {
        key: card.dataset.key as string,
        el: card,
        ghost: null,
        grabX: 0,
        grabY: 0,
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
        timer: 0,
        active: false,
        dropping: false,
        lattice: [],
      };
      session.current = s;
      if (e.pointerType !== 'mouse') {
        s.timer = window.setTimeout(() => lift(s, e.clientX, e.clientY), LONG_PRESS_MS);
      }
    };

    const onMove = (e: PointerEvent) => {
      const s = session.current;
      if (!s || s.pointerId !== e.pointerId || s.dropping) return;
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;

      if (!s.active) {
        const far = Math.hypot(dx, dy);
        if (e.pointerType === 'mouse') {
          if (far <= MOUSE_START_PX) return;
        } else if (far > CANCEL_PX) {
          // 还没到长按点就滑了：那是想滚页面，不是想拖
          window.clearTimeout(s.timer);
          session.current = null;
          return;
        } else {
          return;
        }
        lift(s, e.clientX, e.clientY);
        if (!s.active) return;
      }

      place(s, e.clientX, e.clientY);
      moveTo(e.clientX, e.clientY);

      if (e.clientY < EDGE_PX) window.scrollBy(0, -EDGE_SCROLL_PX);
      else if (e.clientY > window.innerHeight - EDGE_PX) window.scrollBy(0, EDGE_SCROLL_PX);
    };

    const onUp = (e: PointerEvent) => {
      const s = session.current;
      if (!s || s.pointerId !== e.pointerId) return;
      finish(s.active && liveOrder.current.join() !== keys.join());
    };
    const onCancel = () => {
      // 系统抢走指针（来电、手势打断）：按原顺序放回去，不提交
      if (!session.current?.active) return;
      liveOrder.current = keys;
      setOrder(keys);
      finish(false);
    };

    /*
     * 长按的浏览器菜单一定要掐掉。
     *
     * 安卓 Chrome/Edge 在 ~500ms 弹"打开链接 / 下载图片"那张 sheet，弹出来就顺手
     * 发一次 pointercancel —— 我们 400ms 刚起拖，下一秒就被系统收走指针，
     * 表现出来就是"按住了没反应，只出来浏览器菜单"。卡片是 <a> 里套 <img>，
     * 正好是它最爱接管的那种结构。
     */
    const onContextMenu = (e: Event) => e.preventDefault();

    /*
     * 起拖之后要把这根手指从浏览器手里抢过来。
     *
     * 光改 touch-action 来不及（见 lift 里那段）：手指一动，浏览器按 touchstart
     * 时定下的 pan 规则判定"这是要滚书架"，于是发 pointercancel 收走指针流 ——
     * 手机上的表现就是卡片刚起来就弹回原位。
     * 唯一还来得及的口子是 preventDefault 掉 touchmove：长按那 400ms 里手指没动，
     * 滚动根本还没开始，第一次 move 掐掉，这一次手势就再也变不成滚动。
     * 必须 passive:false，否则 preventDefault 无效（上面那个 pointermove 是 passive 的，
     * 挂在那儿没用）。
     */
    const onTouchMove = (e: TouchEvent) => {
      if (session.current?.active) e.preventDefault();
    };

    box.addEventListener('pointerdown', onDown);
    box.addEventListener('contextmenu', onContextMenu);
    /* 挂 window 而不是网格上：拖到底边自动滚屏时手指会出格，出格之后也得掐得住 */
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      box.removeEventListener('pointerdown', onDown);
      box.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      session.current?.ghost?.remove();
      session.current = null;
    };
  }, [enabled, keys, moveTo, finish]);

  return { dragKey, order, containerRef };
}
