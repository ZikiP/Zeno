/**
 * 画面增强：主线程这一侧
 *
 * 三件事：排队（一次只让 Worker 干一张）、缓存（同一张图同一显示宽度只算一次）、
 * 以及"什么时候值得算"（进视野了才算）。
 *
 * 换 src 而不是叠一层 canvas 盖在原图上：覆盖层要么每页挂一张 8MB 的
 * <canvas>（一屏十几页就是上百 MB，手机上必炸），要么把结果编成图再贴上去 ——
 * 既然横竖要编成图，那就直接当 <img> 的 src，object-fit、翻页动画、
 * 长按放大那些逻辑一行都不用改。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { markImageReady } from '@/components/RetryableImage';
import type { EnhanceRequest, EnhanceResponse } from './enhance.worker';
import EnhanceWorker from './enhance.worker?worker';

/** 内存里同时留几张增强结果。一页 PNG 约 2.6MB，12 张 ≈ 31MB */
const CACHE_MAX = 12;
/** 提前多远开始算。太近会来不及（单页约半秒），太远浪费在翻不到的页上 */
const PREFETCH_MARGIN = '200% 0px';

const cache = new Map<string, string>();

type Waiting = { key: string; cbs: ((url: string | null) => void)[] };
const waiting = new Map<number, Waiting>();
/** 同一个 key 正在算时记着它的号，后来者挂到同一件事上 */
const byKey = new Map<string, number>();

type Task = { id: number; src: string; targetW: number; buf: ArrayBuffer };
const queue: Task[] = [];
let worker: Worker | null = null;
let seq = 0;
let busy = false;

function keyOf(src: string, targetW: number) {
  return `${src}@${targetW}`;
}

/**
 * 正在被某页显示着的地址，按消费者计数。
 * 两张页共用同一个地址时（章节里出现重复图），其中一张卸载不能把另一张的保护撤掉。
 */
const pins = new Map<string, number>();
export function pinEnhanced(url: string) {
  pins.set(url, (pins.get(url) ?? 0) + 1);
}
export function unpinEnhanced(url: string) {
  const n = (pins.get(url) ?? 0) - 1;
  if (n > 0) pins.set(url, n);
  else pins.delete(url);
}

/**
 * LRU：命中就重新插到末尾。
 *
 * 三条规矩，缺一条就会把还在显示的地址撤销掉（都踩过）：
 *   - 刚插进来的这条不能是自己的淘汰对象 —— 它这会儿还没被组件 pin 上，
 *     一旦轮到它，页面拿到的就是一个已失效的 blob 地址，直接「加载失败」。
 *   - 一次只腾一个位置，腾不出就作罢。全都还在显示时 cache 允许超上限：
 *     这些地址本来就挂在 DOM 上，撤销它们不会省内存，只会把图弄碎。
 *   - 只撤销 refcount 为 0 的。
 */
function remember(key: string, url: string) {
  cache.delete(key);
  cache.set(key, url);
  if (cache.size <= CACHE_MAX) return;
  for (const [k, u] of cache) {
    if (k === key || (pins.get(u) ?? 0) > 0) continue;
    cache.delete(k);
    URL.revokeObjectURL(u);
    break;
  }
}

/** 一张干完（成功、跳过、失败都算）才能开下一张 */
function finish(id: number, blob: Blob | null) {
  const w = waiting.get(id);
  if (!w) return;
  waiting.delete(id);
  byKey.delete(w.key);
  const url = blob ? URL.createObjectURL(blob) : null;
  if (url) remember(w.key, url);
  for (const cb of w.cbs) cb(url);
  busy = false;
  pump();
}

function workerOf(): Worker {
  if (!worker) {
    worker = new EnhanceWorker();
    worker.onmessage = (e: MessageEvent<EnhanceResponse>) => finish(e.data.id, e.data.ok ? e.data.blob : null);
    worker.onerror = () => {
      /* 挂了就把排着的和在跑的全判失败，别让调用方永远等 */
      for (const id of [...waiting.keys()]) finish(id, null);
      queue.length = 0;
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

function pump() {
  if (busy || !queue.length) return;
  const task = queue.shift();
  if (!task) return;
  busy = true;
  const w = workerOf();
  const req: EnhanceRequest = { id: task.id, buf: task.buf, targetW: task.targetW };
  /* buf 是转移过去的，发出去就没了，所以失败也不能重发这一份 */
  w.postMessage(req, [task.buf]);
}

/**
 * 算出来过、但挂上去失败的地址对应的键。
 * 失败一次就不再重来 —— 否则"退回原图 → 观察器又触发 → 又算一版 → 又失败"会转圈。
 */
const bad = new Set<string>();

/**
 * 取某张图在 targetW 下的增强版地址。
 * 源图本来就不比显示宽度窄（不需要放大）或算不出来时返回 null，调用方继续用原图。
 */
export function enhanceSource(src: string, targetW: number): Promise<string | null> {
  const key = keyOf(src, targetW);
  if (bad.has(key)) return Promise.resolve(null);
  const hit = cache.get(key);
  if (hit) {
    remember(key, hit);
    return Promise.resolve(hit);
  }
  return new Promise<string | null>((resolve) => {
    const running = byKey.get(key);
    if (running !== undefined) {
      waiting.get(running)?.cbs.push(resolve);
      return;
    }
    const id = ++seq;
    waiting.set(id, { key, cbs: [resolve] });
    byKey.set(key, id);
    /* 取字节走主线程的 fetch：离线缓存是 Service Worker 拦文档请求做的，Worker 自己发请求会绕过它 */
    void fetch(src)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => {
        if (!buf) return finish(id, null);
        queue.push({ id, src, targetW, buf });
        pump();
      })
      .catch(() => finish(id, null));
  });
}

/** 这一版挂上去失败过：这个键不再重试，免得退回原图后又被同一个坏地址顶上 */
function giveUp(src: string, targetW: number) {
  bad.add(keyOf(src, targetW));
}

/**
 * 给一张页面图用：进视野后按当前显示宽度算一版增强图，回来就换 src。
 *
 * 顺序不能反 —— 原图先照常显示，增强版晚半秒盖上去。
 * 等算完再显示，翻页就变成每页卡半秒。
 */
export function useEnhancedSource(src: string, enabled: boolean) {
  const ref = useRef<HTMLImageElement>(null);
  const usedW = useRef(0);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    if (!enabled || typeof IntersectionObserver === 'undefined') return;
    const el = ref.current;
    if (!el) return;

    let cancelled = false;
    /*
     * 用 offsetWidth 而不是 getBoundingClientRect().width：
     * 后者把翻页动画的 transform 也算进去，折页那一瞬间量到的宽度是错的。
     */
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        const targetW = Math.round(el.offsetWidth * (window.devicePixelRatio || 1));
        if (targetW < 2) return;
        usedW.current = targetW;
        void enhanceSource(src, targetW).then((u) => {
          if (cancelled || !u) return;
          /* 先登记这个地址能直接画，换上去那一帧才不会是透明的（见 RetryableImage 的 readySrcs） */
          markImageReady(u);
          setUrl(u);
        });
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [src, enabled]);

  /* 正在显示的这张不许被淘汰；换页或关掉开关时松手 */
  useEffect(() => {
    if (!url) return;
    pinEnhanced(url);
    return () => unpinEnhanced(url);
  }, [url]);

  /**
   * 增强版挂上去失败了 → 退回原图。
   * 增强是锦上添花，它失败不能把一页好端端的图换成「加载失败 · 点此重试」。
   */
  const revert = useCallback(() => {
    if (!url) return;
    giveUp(src, usedW.current);
    setUrl(null);
  }, [url, src]);

  return { ref, url, revert };
}
