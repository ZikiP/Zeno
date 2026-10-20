/**
 * 画面增强 Worker
 *
 * 一张页的活：解码 → Lanczos3 重采样到显示尺寸 → 非锐化 → 编成 PNG。
 * 全程在 Worker 里，主线程一次像素都不碰（实测单页约 500ms，放主线程会直接卡住翻页）。
 *
 * 像素由主线程取好再传进来，而不是这里自己 fetch：
 * 离线缓存是 Service Worker 拦文档请求做的，Worker 里发请求绕过它，
 * 断网时这一档就会在明明有缓存的页上失败。
 *
 * 编码选 PNG 而不是 WebP，是量过的（1170×1757 一页）：
 *   PNG  95ms / 2.6MB / 锐度 100% 保留
 *   WebP 407ms / 0.65MB / 96%
 * 慢四倍还顺手把刚补出来的高频糊回去一点，而这功能卖的就是那一点高频。
 * 体积在内存里用不上（blob 只是 <img> 的 src），但**盘上是会存的**：
 * 主线程会把这份写进 Cache Storage（见 enhance.ts 的 persist），重读同一章不重算。
 */
import { enhance, targetHeight, type Pixels } from './enhanceCore';

export type EnhanceRequest = {
  id: number;
  /** 原图字节 */
  buf: ArrayBuffer;
  /** 要放大到的宽度（设备像素） */
  targetW: number;
};

export type EnhanceResponse =
  | { id: number; ok: true; blob: Blob; from: [number, number]; to: [number, number] }
  /** 源图本来就不比显示宽度小，重采样只会白丢信息 */
  | { id: number; ok: false; skip?: 'no-upscale' }
  /** gpuBroken：这一档环境根本跑不了 GPU，后续任务该退回 CPU 池 */
  | { id: number; ok: false; error: string; gpuBroken?: boolean };

self.onmessage = async (e: MessageEvent<EnhanceRequest>) => {
  const { id, buf, targetW } = e.data;
  try {
    const bm = await createImageBitmap(new Blob([buf]));
    /* 只有真放大才值得做：等比或缩小时浏览器那一档已经够了，硬重采样反而丢信息 */
    if (bm.width >= targetW) {
      bm.close();
      (self as unknown as Worker).postMessage({ id, ok: false, skip: 'no-upscale' } satisfies EnhanceResponse);
      return;
    }

    const probe = new OffscreenCanvas(bm.width, bm.height);
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    if (!pctx) throw new Error('no 2d context');
    pctx.drawImage(bm, 0, 0);
    bm.close();
    const d = pctx.getImageData(0, 0, probe.width, probe.height);
    const src: Pixels = { width: d.width, height: d.height, data: d.data };

    const th = targetHeight(src.width, src.height, targetW);
    const out = enhance(src, targetW, th);

    const canvas = new OffscreenCanvas(targetW, th);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    /* 用 createImageData 再填,而不是 new ImageData(bytes,...) —— 后者在 TS 里要求缓冲区是 ArrayBuffer */
    const frame = ctx.createImageData(targetW, th);
    frame.data.set(out.data);
    ctx.putImageData(frame, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    self.postMessage({ id, ok: true, blob, from: [src.width, src.height], to: [targetW, th] } satisfies EnhanceResponse);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies EnhanceResponse);
  }
};
