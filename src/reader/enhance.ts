/**
 * 画面增强：主线程这一侧
 *
 * 这一层管三件事：**取字节**（按优先级放行，别把整章一起拽下来）、**算**（几台 Worker
 * 并行、谁先谁后、跑完记账）、**收场**（成功、跳过、超时、失败都从 settle 走）。
 * 内存里那一份在 enhanceCache.ts（同一张图同一显示宽度只算一次），盘上那一份在
 * enhanceDisk.ts，"这一页什么时候可以画"在 enhancePage.ts。
 *
 * 换 src 而不是叠一层 canvas 盖在原图上：覆盖层要么每页挂一张 8MB 的
 * <canvas>（一屏十几页就是上百 MB，手机上必炸），要么把结果编成图再贴上去 ——
 * 既然横竖要编成图，那就直接当 <img> 的 src，object-fit、翻页动画、长按放大都不用改。
 */
import { bad, cache, keyOf, remember, seenKeys } from './enhanceCache';
import { persistDiskBlob, readDiskBlob } from './enhanceDisk';
import type { EnhanceRequest, EnhanceResponse } from './enhance.worker';
import EnhanceWorker from './enhance.worker?worker';

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




/**
 * Worker 池。
 *
 * 一页在 1440 显示宽下要算 600~900ms，队列排空速度就是台数 × 张数/秒。实测同一章
 * （43~51 页、1440×900 dpr1、Ryzen 7 8745H 16 线程，scripts/verify-enhance-throughput.mjs）：
 *   2 台 1.82 页/秒 · 4 台 3.17 · 6 台 4.08 · 8 台 3.55（回落，抢内存带宽）
 * 所以按核心数开、6 台封底。原来写死 2 台的顾虑是"增强是锦上添花，别把机器占满"，
 * 代价是预取整章要 24 秒 —— 往下翻的人 20 秒就能翻到第 40 页，追不上就是黑屏。
 */
const DEFAULT_POOL = Math.max(2, Math.min(6, Math.round((navigator.hardwareConcurrency || 2) / 2.5)));
/** enhancePool 是量吞吐时改档用的口子（scripts/verify-enhance-throughput.mjs 靠它），平时不设 */
const POOL = Math.max(1, Number(localStorage.getItem('enhancePool')) || DEFAULT_POOL);
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
 * 还没拿到字节的活（也在 waiting 里挂号）。
 *
 * 为什么不照着请求发出去：一章 51 张一起 fetch 就是 21~24MB（实测 resource timing）
 * 挤在同域那 6 条 HTTP/1.1 连接上，屏上那张自己要的字节排在同一个队里；
 * `arrayBuffer()` 又是主线程解的，51 份连着到货会把之后每一帧都往后推。
 * 现在按 prio 取、同时在飞的只有 POOL×2 条：一条字节 ~0.4 秒，12 条并行供 30 页/秒，
 * 而算只有 4~6 页/秒 —— Worker 那边照样不断粮，内存里最多也只留十来份字节。
 */
const prep: Job[] = [];
let fetching = 0;
const FETCH_MAX = POOL * 2;

/** 一张的准备工作：盘上有就包装，没有就取字节再交给算的那一侧 */
async function prepare(job: Job) {
  /* 盘上有就直接包装，一趟 Worker 都不用 */
  const fromDisk = await readDiskBlob(job.key);
  if (fromDisk) return settle(job, fromDisk, true);
  try {
    /* 取字节走主线程的 fetch：离线缓存是 Service Worker 拦文档请求做的，Worker 自己发请求会绕过它 */
    const res = await fetch(job.src);
    const buf = res.ok ? await res.arrayBuffer() : null;
    if (!buf) return settle(job, null);
    job.buf = buf;
    queue.push(job);
    pump();
  } catch {
    settle(job, null);
  }
}

function pumpPrep() {
  while (fetching < FETCH_MAX && prep.length) {
    let best = 0;
    for (let i = 1; i < prep.length; i++) if ((prep[i].prio ?? 0) < (prep[best].prio ?? 0)) best = i;
    const [job] = prep.splice(best, 1);
    fetching++;
    void prepare(job).finally(() => {
      fetching--;
      pumpPrep();
    });
  }
}


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
      /*
       * 这一张已经在排或在算：挂到同一件事上，不要再开一份。
       * 顺手把它往前挪 —— 章级预排是按"离章头多远"给的优先级，用户跳到第 20 页时
       * 那一页排在第 20 号位，于是脚下的图要等前面 19 张算完（实测黑 6.5 秒）。
       * 只准提前不准延后，已经在跑的那几张不动。
       */
      const job = pool.find((p) => p?.id === running) ?? waiting.get(running);
      if (job) {
        if ((job.prio ?? 0) > prio) job.prio = prio;
        job.cbs.push(resolve);
      } else settle({ id: running, key, src, targetW, cbs: [resolve] }, null);
      return;
    }
    const job: Job = { id: ++seq, key, src, targetW, prio, cbs: [resolve] };
    waiting.set(job.id, job);
    byKey.set(key, job.id);
    /* 不在这里就发请求 —— 取字节归 prep 那一档限流管，见 pumpPrep */
    prep.push(job);
    pumpPrep();
  });
}

/** 还没占槽位的活提前收场（盘上命中、字节拿不到、账本对不上） */
function settle(job: Job, blob: Blob | null, fromDisk = false) {
  waiting.delete(job.id);
  if (byKey.get(job.key) === job.id) byKey.delete(job.key);
  const url = blob ? URL.createObjectURL(blob) : null;
  if (url) {
    remember(job.key, url);
    /* 盘上来的那份不再写回盘 —— 实测重开一章因此白写 39 次 × 2.6MB，全在用户正看着的时候 */
    if (!fromDisk) void persistDiskBlob(job.key, blob!);
  }
  for (const cb of job.cbs) cb(url);
  job.cbs.length = 0;
}

/**
 * 把还排在队里的活往前挪（只准提前，不动已经在跑的那几张）。
 * 章级预排的 prio 是"离章头多远"，用户跳到第 20 页时它就在第 20 号位 —— 由排版那一侧
 * 按下屏的那一刻来纠偏。
 */
export function raisePriority(key: string, prio: number) {
  const id = byKey.get(key);
  if (id === undefined) return;
  const job = pool.find((p) => p?.id === id) ?? waiting.get(id);
  if (job && (job.prio ?? 0) > prio) job.prio = prio;
}


