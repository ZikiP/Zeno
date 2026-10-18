/**
 * 画面增强的像素算子
 *
 * 只有两件事：Lanczos3 重采样 + 非锐化掩蔽。纯函数、不碰 DOM，
 * 所以 Worker 和 scripts/test-enhance.ts 跑的是同一份代码。
 *
 * 为什么自己做而不是交给浏览器：Chromium 放大图片只有双线性一档，
 * `imageSmoothingQuality='high'` 对放大的 <img> 完全不起作用（实测像素一模一样），
 * CSS 侧没有可选项。而 959 宽的源页在手机上（390 CSS px × DPR 3 = 1170）
 * 是实打实的 ×1.22 放大，浏览器那一档糊得最明显。
 *
 * 参数是拿真页面测出来的：Lanczos3 比现状 +2.9~3.3 dB 保真、线条区 +19~29% 锐度，
 * 再叠一档非锐化到 +33~69%。阈值 2 是有意留的 —— 不加阈值会把有损压缩的块噪点一起放大。
 */

/** 一块像素：RGBA 每像素 4 字节，行主序 */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export const ENHANCE = {
  /** Lanczos 支半径，3 是「放大」这一路的常用档 */
  radius: 3,
  /** 非锐化补回去的比例 */
  amount: 0.6,
  /** 高斯模糊半径（像素），太小会只糊到单像素噪点 */
  sigma: 1.1,
  /** 低于这个灰度差不补，压掉压缩噪点 */
  threshold: 2,
} as const;

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

const newPixels = (w: number, h: number): Pixels => ({
  width: w,
  height: h,
  data: new Uint8ClampedArray(w * h * 4),
});

/** L(x) = sinc(x/a)·sinc(x)。第二项分母是 πx，写成 πx/a 会得到一个整体偏暗的结果 */
function lanczosKernel(x: number, a: number) {
  if (x === 0) return 1;
  if (x <= -a || x >= a) return 0;
  const px = Math.PI * x;
  return ((a * Math.sin(px / a)) / px) * (Math.sin(px) / px);
}

/**
 * 采样点权重表。边界用钳位（重复边缘像素），不做镜像也不补黑边。
 *
 * 最后除以权重和是必要的，不是保险：Lanczos 核只在近似意义上满足单位分割，
 * 实测每个输出点的权重和在 0.994~1.002 之间起伏 —— 不归一的话整张图会带一层
 * 千分之几的亮度波纹，纯色区域首当其冲（灰 255 能掉到 252）。
 */
function axisWeights(nOut: number, nIn: number, radius: number) {
  const rows: { idx: number[]; wgt: number[] }[] = [];
  for (let o = 0; o < nOut; o++) {
    const center = ((o + 0.5) * nIn) / nOut - 0.5;
    const idx: number[] = [];
    const wgt: number[] = [];
    let sum = 0;
    for (let i = Math.floor(center - radius + 1); i <= Math.floor(center + radius); i++) {
      const w = lanczosKernel(center - i, radius);
      idx.push(Math.min(nIn - 1, Math.max(0, i)));
      wgt.push(w);
      sum += w;
    }
    if (sum !== 0) for (let k = 0; k < wgt.length; k++) wgt[k] /= sum;
    rows.push({ idx, wgt });
  }
  return rows;
}

/**
 * 可分离 Lanczos 重采样：先横后纵，中间缓冲用浮点，只在最后一步量化回 8 位。
 * 分两趟而不是二维卷积，是把 O(r²) 降到 O(2r)。
 */
export function resample(src: Pixels, tw: number, th: number, radius = ENHANCE.radius): Pixels {
  const { width: sw, height: sh, data } = src;
  const hw = axisWeights(tw, sw, radius);
  const vw = axisWeights(th, sh, radius);

  const mid = new Float32Array(tw * sh * 3);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < tw; x++) {
      const { idx, wgt } = hw[x];
      let r = 0,
        g = 0,
        b = 0;
      for (let k = 0; k < idx.length; k++) {
        const p = (y * sw + idx[k]) * 4;
        r += data[p] * wgt[k];
        g += data[p + 1] * wgt[k];
        b += data[p + 2] * wgt[k];
      }
      const q = (y * tw + x) * 3;
      mid[q] = r;
      mid[q + 1] = g;
      mid[q + 2] = b;
    }
  }

  const out = newPixels(tw, th);
  for (let y = 0; y < th; y++) {
    const { idx, wgt } = vw[y];
    for (let x = 0; x < tw; x++) {
      let r = 0,
        g = 0,
        b = 0;
      for (let k = 0; k < idx.length; k++) {
        const q = (idx[k] * tw + x) * 3;
        r += mid[q] * wgt[k];
        g += mid[q + 1] * wgt[k];
        b += mid[q + 2] * wgt[k];
      }
      const p = (y * tw + x) * 4;
      out.data[p] = clamp255(r);
      out.data[p + 1] = clamp255(g);
      out.data[p + 2] = clamp255(b);
      out.data[p + 3] = 255;
    }
  }
  return out;
}

function gauss(sigma: number) {
  const r = Math.max(1, Math.round(sigma * 2));
  const k: number[] = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  return { k: k.map((v) => v / sum), r };
}

/** 单通道可分离高斯。三通道各跑一次，比在核里带通道数少一半内存跳动 */
function blur(channel: Float32Array, w: number, h: number, sigma: number) {
  const { k, r } = gauss(sigma);
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += channel[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r];
      tmp[y * w + x] = acc;
    }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r];
      out[y * w + x] = acc;
    }
  return out;
}

/** 非锐化掩蔽：原图 + amount ×（原图 − 模糊），差值没过阈子的地方不补 */
export function unsharp(src: Pixels, amount = ENHANCE.amount, sigma = ENHANCE.sigma, threshold = ENHANCE.threshold): Pixels {
  const { width: w, height: h, data } = src;
  const out = newPixels(w, h);
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(w * h);
    for (let i = 0, p = c; i < ch.length; i++, p += 4) ch[i] = data[p];
    const soft = blur(ch, w, h, sigma);
    for (let i = 0, p = c; i < ch.length; i++, p += 4) {
      const d = ch[i] - soft[i];
      out.data[p] = clamp255(ch[i] + amount * (Math.abs(d) > threshold ? d : 0));
    }
  }
  for (let p = 3; p < out.data.length; p += 4) out.data[p] = 255;
  return out;
}

/** 增强一档：先按目标尺寸重采样，再补高频。顺序不能反，锐化要在最终分辨率上做 */
export function enhance(src: Pixels, tw: number, th: number): Pixels {
  return unsharp(resample(src, tw, th));
}

/** 目标宽度下该配多高。保持长宽比，跟 <img> 的 height:auto 一致 */
export const targetHeight = (naturalW: number, naturalH: number, tw: number) =>
  Math.max(1, Math.round((naturalH * tw) / naturalW));
