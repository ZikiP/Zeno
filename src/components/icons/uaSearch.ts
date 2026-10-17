import type { Animation } from 'react-useanimations';

/**
 * 搜索 tab 的图标 —— UseAnimations 没有可用的放大镜（只有 searchToX，
 * 点一下变成叉，当 tab 的选中态语义正好反），所以按它的格式自己做一颗。
 *
 * 演法：选中 = 先往左甩一下蓄力，再往右转、冲过头一点、回稳在 +20°；
 * 取消 = 同一条时间轴倒放，于是变成往右多走一点、再往左甩回 0°。
 * click-toggle 的正反放是播放器给的，两半都是同一组关键帧，不会正反长得不一样。
 *
 * 结构照抄 react-useanimations/lib/book.mjs（它也用 ks.r 关键帧）：一个元素一层，
 * 描边用 st，跟色（--ua-stroke → currentColor）和旋转都走同一条代码路径。
 */

/** 24 单位设计空间里的圆，转成 Lottie 的四段贝塞尔（i/o 是相对顶点的切线） */
function circle(cx: number, cy: number, r: number) {
  const k = +(0.5523 * r).toFixed(2);
  // 图层锚点在 12,12，所以顶点写相对中心
  const v = (x: number, y: number) => [+(x - 12).toFixed(2), +(y - 12).toFixed(2)];
  return {
    i: [[-k, 0], [0, -k], [k, 0], [0, k]],
    o: [[k, 0], [0, k], [-k, 0], [0, -k]],
    v: [v(cx, cy - r), v(cx + r, cy), v(cx, cy + r), v(cx - r, cy)],
    c: true,
  };
}

const CX = 10;
const CY = 10;
const R = 6.8;
/** 手柄从 45° 方向的镜圈外沿拉到角上 */
const EDGE = +(R * 0.7071 + 0.6).toFixed(2);
const HANDLE_END = 9;

const DURATION = 16; // 30fps 下约 533ms
const REST = 20; // 选中后停的角度

/** 每层都要自己的一份关键帧，播放器会就地改这些对象 */
const spin = () => ({
  a: 1,
  k: [
    { t: 0, s: [0], o: { x: [0], y: [0] }, i: { x: [0.58], y: [1] } },
    { t: 4, s: [-12], o: { x: [0], y: [0] }, i: { x: [0.58], y: [1] } },
    { t: 10, s: [REST + 8], o: { x: [0.42], y: [0] }, i: { x: [0.58], y: [1] } },
    { t: DURATION, s: [REST] },
  ],
});

const stroke = {
  ty: 'st',
  c: { a: 0, k: [0, 0, 0, 1] },
  o: { a: 0, k: 100 },
  w: { a: 0, k: 2 },
  lc: 2,
  lj: 2,
  bm: 0,
};

const layer = (ind: number, shape: unknown) => ({
  ddd: 0,
  ind,
  ty: 4,
  sr: 1,
  ks: {
    o: { a: 0, k: 100 },
    r: spin(),
    p: { a: 0, k: [16, 16, 0] },
    a: { a: 0, k: [12, 12, 0] },
    s: { a: 0, k: [100, 100, 100] },
  },
  ao: 0,
  shapes: [
    {
      ty: 'gr',
      it: [
        { ind: 0, ty: 'sh', ks: { a: 0, k: shape } },
        stroke,
        {
          ty: 'tr',
          p: { a: 0, k: [12, 12] },
          a: { a: 0, k: [0, 0] },
          s: { a: 0, k: [100, 100] },
          r: { a: 0, k: 0 },
          o: { a: 0, k: 100 },
          sk: { a: 0, k: 0 },
          sa: { a: 0, k: 0 },
        },
      ],
      bm: 0,
    },
  ],
  ip: 0,
  op: DURATION,
  st: 0,
  bm: 0,
});

const handle = {
  i: [
    [0, 0],
    [0, 0],
  ],
  o: [
    [0, 0],
    [0, 0],
  ],
  v: [
    [+(CX + EDGE - 12).toFixed(2), +(CY + EDGE - 12).toFixed(2)],
    [HANDLE_END, HANDLE_END],
  ],
  c: false,
};

const animationData = {
  nm: 'search',
  v: '5.6.5',
  fr: 30,
  ip: 0,
  op: DURATION,
  w: 32,
  h: 32,
  ddd: 0,
  assets: [],
  layers: [layer(1, circle(CX, CY, R)), layer(2, handle)],
  markers: [],
};

export const searchToggle: Animation = { animationData, interaction: 'click-toggle' };
