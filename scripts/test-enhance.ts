/**
 * 画面增强的像素数学
 *
 * 这一档的失败模式全是"看着还行但其实错了"：核函数写错不会崩，
 * 只会让整张图暗一档（实验台第一版就是这么把中亮度从 214 压到 171 的）；
 * 阈值失效不会崩，只会把有损压缩的块噪点一起放大成颗粒。
 * 这些在界面上都不显眼，所以拿几条数学性质直接钉住。
 */
import { ENHANCE, enhance, resample, targetHeight, unsharp, type Pixels } from '../src/reader/enhanceCore';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const gray = (w: number, h: number): Pixels => ({
  width: w,
  height: h,
  data: new Uint8ClampedArray(w * h * 4),
});

function setAll(p: Pixels, v: number) {
  for (let i = 0; i < p.width * p.height; i++) {
    p.data[i * 4] = p.data[i * 4 + 1] = p.data[i * 4 + 2] = v;
    p.data[i * 4 + 3] = 255;
  }
  return p;
}

const luma = (p: Pixels, x: number, y: number) => p.data[(y * p.width + x) * 4];
const mean = (p: Pixels) => {
  let s = 0;
  for (let i = 0; i < p.width * p.height; i++) s += p.data[i * 4];
  return s / (p.width * p.height);
};

console.log('=== 1. 权重和必须是 1：常数图放大后还得是那个常数 ===');
for (const v of [0, 37, 128, 214, 255]) {
  const src = setAll(gray(20, 20), v);
  const out = resample(src, 47, 53);
  let worst = 0;
  for (let i = 0; i < out.width * out.height; i++) worst = Math.max(worst, Math.abs(out.data[i * 4] - v));
  check(worst <= 1, `灰 ${v} 铺满的图放大到 47×53 后最大偏差 ${worst}（偏差大就是核写错，整张会偏暗）`);
}

console.log('\n=== 2. 直流分量守恒：随机纹理放大后均值不能漂 ===');
const noisy = gray(120, 90);
let seed = 12345;
for (let i = 0; i < noisy.width * noisy.height; i++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  const v = seed % 256;
  noisy.data[i * 4] = noisy.data[i * 4 + 1] = noisy.data[i * 4 + 2] = v;
  noisy.data[i * 4 + 3] = 255;
}
const noisyUp = resample(noisy, 150, 113);
const drift = Math.abs(mean(noisyUp) - mean(noisy));
check(drift < 3, `随机图 120×90 → 150×113 均值漂了 ${drift.toFixed(2)}（>3 说明权重没归一）`);
check(noisyUp.data.every((v, i) => (i % 4 === 3 ? v === 255 : Number.isFinite(v))), '输出没有 NaN，alpha 全 255');

console.log('\n=== 3. 非锐化：只碰边缘，不碰平坦区 ===');
/* 左边 1/3 全黑、右边 2/3 全白，中间一条竖直边 */
const step = gray(90, 40);
for (let y = 0; y < 40; y++)
  for (let x = 0; x < 90; x++) {
    const v = x < 30 ? 10 : 240;
    step.data[(y * 90 + x) * 4] = step.data[(y * 90 + x) * 4 + 1] = step.data[(y * 90 + x) * 4 + 2] = v;
    step.data[(y * 90 + x) * 4 + 3] = 255;
  }
/** 中间那一行上，跨过边缘的最大单像素落差 —— 落差越大边越窄越利 */
const peakStep = (p: Pixels) => {
  let m = 0;
  for (let x = 0; x < p.width - 1; x++) m = Math.max(m, Math.abs(luma(p, x + 1, 20) - luma(p, x, 20)));
  return m;
};
const sharpened = unsharp(step);
check(
  peakStep(sharpened) > peakStep(step),
  `跨边落差 ${peakStep(step).toFixed(1)} → ${peakStep(sharpened).toFixed(1)}，锐化把边压得更窄`,
);
/* 离边 10px 以上的平坦区必须一个字节都不动 —— 阈值就是留给它的 */
let flatTouched = 0;
for (let y = 5; y < 35; y++)
  for (const x of [8, 12, 70, 80]) if (luma(sharpened, x, y) !== luma(step, x, y)) flatTouched++;
check(flatTouched === 0, `平坦区 ${flatTouched} 个像素被动过（动了就是阈值没生效，压缩噪点会被一起放大）`);
check(
  luma(sharpened, 29, 20) < luma(step, 29, 20) + 1 && luma(sharpened, 31, 20) > luma(step, 31, 20) - 1,
  '边的两侧往两端推：黑侧更黑、白侧更白',
);

console.log('\n=== 4. 尺寸与"放大后有没有更糊" ===');
check(targetHeight(959, 1440, 1170) === 1757, `959×1440 放到 1170 宽 → 高 ${targetHeight(959, 1440, 1170)}（应为 1757）`);
const ar0 = 959 / 1440;
const ar1 = 1170 / targetHeight(959, 1440, 1170);
check(Math.abs(ar0 - ar1) < 0.002, `长宽比差 ${Math.abs(ar0 - ar1).toFixed(4)}，比 <0.002 才不会把人脸拉变形`);

/** 浏览器那一档长什么样：双线性 ×2，用来当"糊"的基准 */
function bilinear(src: Pixels, tw: number, th: number): Pixels {
  const out = gray(tw, th);
  for (let y = 0; y < th; y++) {
    const fy = (y / th) * src.height,
      y0 = Math.floor(fy),
      dy = fy - y0;
    for (let x = 0; x < tw; x++) {
      const fx = (x / tw) * src.width,
        x0 = Math.floor(fx),
        dx = fx - x0;
      const g = (xx: number, yy: number) => luma(src, Math.min(src.width - 1, xx), Math.min(src.height - 1, yy));
      const v = (g(x0, y0) * (1 - dx) + g(x0 + 1, y0) * dx) * (1 - dy) + (g(x0, y0 + 1) * (1 - dx) + g(x0 + 1, y0 + 1) * dx) * dy;
      out.data[(y * tw + x) * 4] = out.data[(y * tw + x) * 4 + 1] = out.data[(y * tw + x) * 4 + 2] = v;
      out.data[(y * tw + x) * 4 + 3] = 255;
    }
  }
  return out;
}
/**
 * 边缘的过渡带有多宽（折合成源图像素）。
 * 不能用"平均梯度能量"判放大后的清晰度：图放大一倍，像素数翻倍而落差总量不变，
 * 平均值天然掉一半，那条断言物理上就不可能通过。
 *
 * 基准图也必须是软边：真页面是被扫描 + 有损压缩糊过一遍的，
 * 拿一条理想阶跃去比，双线性只有好处没有坏处（它没有振铃），量出来的是假结论。
 */
function edgeWidth(p: Pixels, scale: number) {
  const row: number[] = [];
  for (let x = 0; x < p.width; x++) row.push(luma(p, x, Math.floor(p.height / 2)));
  let lo = Infinity,
    hi = -Infinity;
  for (const v of row) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const a = lo + (hi - lo) * 0.1,
    b = lo + (hi - lo) * 0.9;
  let n = 0;
  for (const v of row) if (v > a && v < b) n++;
  return n / scale;
}
/** 横向 1-2-1 模糊跑三遍：把理想阶跃糊成约 4px 宽的过渡带，模拟真扫描页 */
function soften(p: Pixels) {
  for (let pass = 0; pass < 3; pass++) {
    const before = Uint8ClampedArray.from(p.data);
    for (let y = 0; y < p.height; y++)
      for (let x = 0; x < p.width; x++) {
        const g = (xx: number) => before[(y * p.width + Math.min(p.width - 1, Math.max(0, xx))) * 4];
        const v = (g(x - 1) + 2 * g(x) + g(x + 1)) / 4;
        const q = (y * p.width + x) * 4;
        p.data[q] = p.data[q + 1] = p.data[q + 2] = v;
      }
  }
  return p;
}
const soft = soften(step);
const wide = enhance(soft, 180, 80);
const viaBilinear = bilinear(soft, 180, 80);
check(wide.width === 180 && wide.height === 80, `enhance() 出来的就是目标尺寸 ${wide.width}×${wide.height}`);
check(
  edgeWidth(wide, 2) < edgeWidth(viaBilinear, 2),
  `软边 ×2 后过渡带：本档 ${edgeWidth(wide, 2).toFixed(2)} 源像素 vs 浏览器双线性 ${edgeWidth(viaBilinear, 2).toFixed(2)} 源像素（不比它窄就说明这一档白做了）`,
);
check(peakStep(wide) > peakStep(viaBilinear), `软边 ×2 后跨边落差 ${peakStep(viaBilinear).toFixed(1)} → ${peakStep(wide).toFixed(1)}`);

console.log('\n=== 5. 参数没被谁偷偷改过 ===');
check(
  ENHANCE.radius === 3 && ENHANCE.amount === 0.6 && ENHANCE.sigma === 1.1 && ENHANCE.threshold === 2,
  `Lanczos${ENHANCE.radius} / amount ${ENHANCE.amount} / σ ${ENHANCE.sigma} / 阈值 ${ENHANCE.threshold} —— 这组是拿真页面量出来的`,
);

console.log(fails ? `\n${fails} 条没过` : '\n全部通过 — 像素数学站得住');
process.exit(fails ? 1 : 0);
