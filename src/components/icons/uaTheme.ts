import type { Animation } from 'react-useanimations';

/**
 * 主题切换图标 —— 太阳 ↔ 月牙的真形变。
 *
 * UseAnimations 没有可用的双状态主题图标（sun / moon 都只有 hover 演法，
 * 触屏上 hover 直接被忽略），所以按它的格式自己做一颗。
 *
 * 月牙不是「圆上挖个洞」画出来的：顶栏是玻璃材质（半透明白 + backdrop-blur +
 * 透镜滤镜），拿一个实心圆去遮它，身后滚过内容时洞的颜色就对不上了。
 * 这里镜圈本身从圆形变形成月牙（同一条闭合路径、同样 32 个顶点逐点插值），
 * 全程只有描边，任何底色下都成立。射线则缩回、淡出。
 *
 * 顶点数据是在浏览器里用 getPointAtLength 把「圆」和 lucide 的月亮轮廓各采 32 点、
 * 再把两组点按最小位移对齐得到的；格式照 react-useanimations/lib/archive.mjs
 * 的 sh 关键帧抄，走同一个播放器的同一条代码路径。
 */

const N = 32;
const DURATION = 14; // 30fps 下约 467ms
const BLACK = [0, 0, 0, 1];

/** 太阳镜圈（r=5，圆心在原点） */
const SUN: number[][] = [
  [5, 0], [4.9, 0.98], [4.62, 1.91], [4.16, 2.78], [3.54, 3.54], [2.78, 4.16],
  [1.91, 4.62], [0.98, 4.9], [0, 5], [-0.98, 4.9], [-1.91, 4.62], [-2.78, 4.16],
  [-3.54, 3.54], [-4.16, 2.78], [-4.62, 1.91], [-4.9, 0.98], [-5, 0], [-4.9, -0.98],
  [-4.62, -1.91], [-4.16, -2.78], [-3.54, -3.54], [-2.78, -4.16], [-1.91, -4.62],
  [-0.98, -4.9], [0, -5], [0.98, -4.9], [1.91, -4.62], [2.78, -4.16], [3.54, -3.54],
  [4.16, -2.78], [4.62, -1.91], [4.9, -0.98],
];

/** 月牙（同样 32 点，末尾 8 点向内收出缺口；开口朝右上） */
const MOON: number[][] = [
  [4.18, 0.24], [5, 0.27], [4.83, 1.29], [4.47, 2.26], [3.9, 3.13], [3.17, 3.86],
  [2.31, 4.44], [1.34, 4.81], [0.32, 4.99], [-0.71, 4.95], [-1.72, 4.69], [-2.65, 4.24],
  [-3.47, 3.6], [-4.13, 2.81], [-4.63, 1.9], [-4.92, 0.9], [-5, -0.13], [-4.87, -1.16],
  [-4.52, -2.14], [-3.99, -3.02], [-3.28, -3.78], [-2.43, -4.38], [-1.48, -4.79],
  [-0.46, -4.99], [-0.16, -4.35], [-0.5, -3.37], [-0.52, -2.34], [-0.23, -1.35],
  [0.36, -0.49], [1.18, 0.13], [2.15, 0.49], [3.18, 0.52],
];

const zero = () => Array.from({ length: N }, () => [0, 0]);
const shape = (v: number[][]) => ({ i: zero(), o: zero(), v, c: true });

/** 变的过程中甩一下再回正：中间帧转 -22°，首尾都是 0°，所以终态朝向是准的 */
const SWING = {
  a: 1,
  k: [
    { t: 0, s: [0], o: { x: [0.42], y: [0] }, i: { x: [0.58], y: [1] } },
    { t: 7, s: [-22], o: { x: [0.42], y: [0] }, i: { x: [0.58], y: [1] } },
    { t: DURATION, s: [0] },
  ],
};

const layerXform = (rotation: unknown) => ({
  o: { a: 0, k: 100 },
  r: rotation,
  p: { a: 0, k: [16, 16, 0] },
  a: { a: 0, k: [12, 12, 0] },
  s: { a: 0, k: [100, 100, 100] },
});

const stroke = {
  ty: 'st',
  c: { a: 0, k: BLACK },
  o: { a: 0, k: 100 },
  w: { a: 0, k: 2 },
  lc: 2,
  lj: 2,
  bm: 0,
};

const group = (items: unknown[], scale: unknown, opacity: unknown) => ({
  ty: 'gr',
  it: [
    ...items,
    {
      ty: 'tr',
      p: { a: 0, k: [12, 12] },
      a: { a: 0, k: [0, 0] },
      s: scale,
      r: { a: 0, k: 0 },
      o: opacity,
      sk: { a: 0, k: 0 },
      sa: { a: 0, k: 0 },
    },
  ],
  bm: 0,
});

const layer = (ind: number, g: unknown, rotation: unknown) => ({
  ddd: 0,
  ind,
  ty: 4,
  sr: 1,
  ks: layerXform(rotation),
  ao: 0,
  shapes: [g],
  ip: 0,
  op: DURATION,
  st: 0,
  bm: 0,
});

/** 射线：亮态在，暗态缩回并淡出；每根错开两帧，看起来是依次收掉 */
const RAYS = Array.from({ length: 8 }, (_, k) => {
  const a = (k * Math.PI) / 4;
  const [ix, iy] = [Math.cos(a) * 6.9, Math.sin(a) * 6.9];
  const [ox, oy] = [Math.cos(a) * 8.9, Math.sin(a) * 8.9];
  return {
    v: [
      [+ix.toFixed(2), +iy.toFixed(2)],
      [+ox.toFixed(2), +oy.toFixed(2)],
    ],
    start: 1 + k * 0.6,
  };
});

const rayScale = (start: number) => ({
  a: 1,
  k: [
    { t: 0, s: [100, 100], o: { x: [0.4], y: [0] }, i: { x: [0.6], y: [1] } },
    { t: start + 6, s: [0, 0] },
  ],
});
const rayOpacity = (start: number) => ({
  a: 1,
  k: [
    { t: 0, s: [100], o: { x: [0.4], y: [0] }, i: { x: [0.6], y: [1] } },
    { t: start + 4, s: [0] },
  ],
});

const animationData = {
  nm: 'theme',
  v: '5.6.5',
  fr: 30,
  ip: 0,
  op: DURATION,
  w: 32,
  h: 32,
  ddd: 0,
  assets: [],
  layers: [
    /* 镜圈 ↔ 月牙 */
    layer(
      1,
      group(
        [
          {
            ind: 0,
            ty: 'sh',
            ks: {
              a: 1,
              k: [
                { t: 0, s: [shape(SUN)], o: { x: 0.4, y: 0 }, i: { x: 0.6, y: 1 } },
                { t: DURATION, s: [shape(MOON)] },
              ],
            },
          },
          stroke,
        ],
        { a: 0, k: [100, 100] },
        { a: 0, k: 100 },
      ),
      SWING,
    ),
    ...RAYS.map((r, k) =>
      layer(
        2 + k,
        group(
          [{ ind: 0, ty: 'sh', ks: { a: 0, k: { i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]], v: r.v, c: false } } }, stroke],
          rayScale(r.start),
          rayOpacity(r.start),
        ),
        { a: 0, k: 0 },
      ),
    ),
  ],
  markers: [],
};

export const themeToggle: Animation = { animationData, interaction: 'click-toggle' };
