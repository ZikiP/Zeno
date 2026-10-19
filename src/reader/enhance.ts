/**
 * 画面增强：主线程这一侧
 *
 * 五件事：排队（几台 Worker 并行，离屏幕近的先干）、内存里的结果（同一张图同一
 * 显示宽度只算一次）、盘上的结果（Cache Storage，重读不用重算）、同步问一句有没有
 * 现成的（peekEnhanced），以及门控 —— 增强版没就绪时这一页先不画，别让原图占一帧
 * 再被硬换掉。
 *
 * 换 src 而不是叠一层 canvas 盖在原图上：覆盖层要么每页挂一张 8MB 的
 * <canvas>（一屏十几页就是上百 MB，手机上必炸），要么把结果编成图再贴上去 ——
 * 既然横竖要编成图，那就直接当 <img> 的 src，object-fit、翻页动画、长按放大都不用改。
 */
import { markImageReady } from '@/components/RetryableImage';
import { persistDiskBlob, readDiskBlob } from './enhanceDisk';
import type { EnhanceRequest, EnhanceResponse } from './enhance.worker';
import EnhanceWorker from './enhance.worker?worker';

/**
 * 内存里同时留几张增强结果。
 *
 * 这条上限就是"翻过去的那一页是增强图还是空白"的另一半：预取排得再前，
 * 算完的结果要是先被挤掉了，那一页还是要重算、还是要等。blob 活在浏览器的
 * blob store 里（不在 JS 堆上，见 enhance.worker.ts），放宽的代价是那些 PNG
 * 副本，约 2.6MB × 张数。
 */
const CACHE_MAX = 80;
/**
 * 超出上限太多时，连"还挂在 DOM 上"的也撤销。
 *
 * 撤销一个正在用的 blob 地址不会把已显示的图弄坏 —— <img> 早就解码进自己的
 * 位图了，revoke 只挡住"以后再用这个地址加载一次"。真正会被咬到的只有这一种：
 * 组件卸载重挂、拿同一个地址重新加载一遍。所以留 8 张余量（一屏最多两张、
 * 回翻时同时挂着的也就这个量级），到顶再硬撤销。
 */
const CACHE_HARD = CACHE_MAX + 8;
export const cache = new Map<string, string>();

/** 排队中（等字节到手）和正在跑（占了槽位）都记在这，两份共用一个形状 */
type Job = { id: number; key: string; src: string; targetW: number; cbs: ((url: string | null) => void)[]; prio?: number; buf?: ArrayBuffer };
const waiting = new Map<number, Job>();

/**
 * 正在跑的那几张：按槽位记（不是按"在跑的数量"记）。
 *
 * 为什么不是简单的 busy 计数：上一版用 inflight 计数 + 槽下标 = 计数-1，
 * 而一次「同一张任务被 finish 两回」就能把计数打成负数，于是每次 pump 都去
 * 新建一台 Worker（实测 reload 那一趟建了 12 台）。按槽记账之后，finish 只认
 * 那张任务当初领的槽，重复调用直接被槽位空判挡掉。
 */
const pool: (Job & { buf: ArrayBuffer; timer: number } | undefined)[] = [];
const queue: Job[] = [];
const byKey = new Map<string, number>();
/** 发出去之后一直没回话的任务（Worker 挂了、消息丢了）到点自己收场 */
const TASK_TIMEOUT_MS = 20_000;

const newWorker = (slot: number): Worker => {
  const w = new EnhanceWorker();
  w.onmessage = (e: MessageEvent<EnhanceResponse>) => {
    const r = pool[slot];
    if (!r || r.id !== e.data.id) return;
    finish(slot, e.data.ok ? e.data.blob : null);
  };
  w.onerror = () => {
    /* 只收这台自己的账：整池一起杀会把跟它无关的任务全判失败（上一版就是这么干的） */
    const r = pool[slot];
    if (r) finish(slot, null);
    try {
      w.terminate();
    } catch {
      /* 已经没了 */
    }
    workers[slot] = undefined;
    pump();
  };
  workers[slot] = w;
  return w;
};

let seq = 0;

export function keyOf(src: string, targetW: number) {
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
 * 规矩，缺一条就会把还在显示的地址撤销掉（都踩过）：
 *   - 刚插进来的这条不能是自己的淘汰对象 —— 它这会儿还没被组件 pin 上，
 *     一旦轮到它，页面拿到的就是一个已失效的 blob 地址，直接「加载失败」。
 *   - 只撤销 refcount 为 0 的，一次腾一个位置。
 *   - 但**必须有顶**：滚动模式整章都挂在 DOM 上、全都被 pin 住，190 页读到底
 *     就是 190 张 × 2.6MB。所以超过 CACHE_HARD 时开始撤销最老的、还在显示的，
 *     理由见 CACHE_MAX 那段（已解码的那张不会被弄坏）。撤销过的地址盘上还有，
 *     真被重新要用时从盘上取回来，不重算。
 */
function remember(key: string, url: string) {
  cache.delete(key);
  cache.set(key, url);
  if (cache.size <= CACHE_MAX) return;
  for (const [k, u] of cache) {
    if (k === key || (pins.get(u) ?? 0) > 0) continue;
    drop(k, u);
    break;
  }
  if (cache.size <= CACHE_HARD) return;
  for (const [k, u] of cache) {
    if (k === key) continue;
    drop(k, u);
    break;
  }
}

/**
 * 从内存里腾位置。
 *
 * **盘上那一份不动** —— 这一层就是内存腾不出来的去处，删了它等于白落盘
 * （实测过：40 页读到底、内存把开头几张顶掉之后再回去，盘上也没了，
 * 于是又老老实实重算一遍）。体积交给浏览器的配额管理，它自己会清。
 */
function drop(key: string, url: string) {
  cache.delete(key);
  URL.revokeObjectURL(url);
}

/**
 * Worker 池。
 *
 * 一页要算 310~500ms 而它只吃一个核 —— 章级预取排到章尾之后，队列的排空速度
 * 就是阅读能不能不被空白追上。手机上 hardwareConcurrency 常常是 8，但那是
 * 大小核一起报，浏览器给 Worker 的未必是 8 个真并行，而且增强是锦上添花，
 * 不该把用户的机器占满 —— 顶多两台。
 */
const POOL = Math.max(1, Math.min(2, navigator.hardwareConcurrency || 2));
const workers: (Worker | undefined)[] = [];

/** 一张干完（成功、跳过、失败都算）：交结果、还槽位 */
function finish(slot: number, blob: Blob | null) {
  const r = pool[slot];
  if (!r) return;
  pool[slot] = undefined;
  clearTimeout(r.timer);
  if (byKey.get(r.key) === r.id) byKey.delete(r.key);
  const url = blob ? URL.createObjectURL(blob) : null;
  if (url && blob) {
    remember(r.key, url);
    void persistDiskBlob(r.key, blob);
  }
  for (const cb of r.cbs) cb(url);
  pump();
}

/**
 * 取下一个该算的：离屏幕近的先算。
 *
 * 按挂载顺序（FIFO）算的话，用户脚下那一页可能排在末尾，那几张就都得先看一次
 * "原图被硬换成增强版"；按到视口的距离排，先出的必然是正在看的那几张，
 * 门控期也因此最短。
 */
function takeNext(): Job | undefined {
  if (!queue.length) return undefined;
  let best = 0;
  for (let i = 1; i < queue.length; i++) if ((queue[i].prio ?? 0) < (queue[best].prio ?? 0)) best = i;
  const [job] = queue.splice(best, 1);
  return job;
}

/** 把队首派给某个空闲槽位 */
function dispatch(job: Job, slot: number) {
  const buf = job.buf;
  if (!buf) return;
  const w = workers[slot] ?? newWorker(slot);
  pool[slot] = { ...job, buf, timer: window.setTimeout(() => finish(slot, null), TASK_TIMEOUT_MS) };
  const req: EnhanceRequest = { id: job.id, buf, targetW: job.targetW };
  /* buf 是转移过去的，发出去就没了，所以失败也不能重发这一份 */
  w.postMessage(req, [buf]);
}

function freeSlot(): number {
  for (let i = 0; i < POOL; i++) if (!pool[i]) return i;
  return -1;
}

function pump() {
  while (queue.length) {
    const slot = freeSlot();
    if (slot < 0) return;
    const job = takeNext();
    if (!job) return;
    if (!waiting.has(job.id)) continue;
    waiting.delete(job.id);
    byKey.set(job.key, job.id);
    dispatch(job, slot);
  }
}

/**
 * 算出来过、但挂上去失败的地址对应的键。
 * 失败一次就不再重来 —— 否则"退回原图 → 观察器又触发 → 又算一版 → 又失败"会转圈。
 */
export const bad = new Set<string>();

/** 已经交过活（在排、在算、已算完）的键，只给 queueAhead 用来不重复排队 */
export const seenKeys = new Set<string>();

/**
 * 取某张图在 targetW 下的增强版地址。
 * 源图本来就不比显示宽度窄（不需要放大）或算不出来时返回 null，调用方继续用原图。
 *
 * prio 是"离视口有多近"，小的先算（见 takeNext）。
 * 三道命中：内存 → 盘上 → 真算一张。后两道都是异步的，所以这一路一定要 await；
 * 能在同一帧里给出来的只有内存那道（peekEnhanced 负责）。
 */
export function enhanceSource(src: string, targetW: number, prio = 0): Promise<string | null> {
  const key = keyOf(src, targetW);
  if (bad.has(key)) return Promise.resolve(null);
  const hit = cache.get(key);
  if (hit) {
    remember(key, hit);
    return Promise.resolve(hit);
  }
  seenKeys.add(key);
  return new Promise<string | null>((resolve) => {
    const running = byKey.get(key);
    if (running !== undefined) {
      /* 这一张已经在排或在算：挂到同一件事上，不要再开一份 */
      const job = pool.find((p) => p?.id === running) ?? waiting.get(running);
      job?.cbs.push(resolve);
      if (!job) settle({ id: running, key, src, targetW, cbs: [resolve] }, null);
      return;
    }
    const job: Job = { id: ++seq, key, src, targetW, prio, cbs: [resolve] };
    waiting.set(job.id, job);
    byKey.set(key, job.id);
    void (async () => {
      /* 盘上有就直接包装，一趟 Worker 都不用 */
      const fromDisk = await readDiskBlob(key);
      if (fromDisk) return settle(job, fromDisk);
      /* 取字节走主线程的 fetch：离线缓存是 Service Worker 拦文档请求做的，Worker 自己发请求会绕过它 */
      try {
        const res = await fetch(src);
        const buf = res.ok ? await res.arrayBuffer() : null;
        if (!buf) return settle(job, null);
        job.buf = buf;
        queue.push(job);
        pump();
      } catch {
        settle(job, null);
      }
    })();
  });
}

/** 还没占槽位的活提前收场（盘上命中、字节拿不到、账本对不上） */
function settle(job: Job, blob: Blob | null) {
  waiting.delete(job.id);
  if (byKey.get(job.key) === job.id) byKey.delete(job.key);
  const url = blob ? URL.createObjectURL(blob) : null;
  if (url) {
    remember(job.key, url);
    void persistDiskBlob(job.key, blob!);
  }
  for (const cb of job.cbs) cb(url);
  job.cbs.length = 0;
}

/**
 * 同步问一句：这张图的增强版是不是已经躺在那儿了。
 * 命中就能在 useLayoutEffect 里直接当 src 用 —— 第一次 paint 画的就是增强版。
 */
export function peekEnhanced(src: string, targetW: number): string | null {
  const key = keyOf(src, targetW);
  if (bad.has(key) || targetW < 2) return null;
  const hit = cache.get(key);
  if (!hit) return null;
  remember(key, hit);
  markImageReady(hit);
  return hit;
}

/** 这一版挂上去失败过：这个键不再重试，免得退回原图后又被同一个坏地址顶上 */
export function giveUp(src: string, targetW: number) {
  bad.add(keyOf(src, targetW));
}
