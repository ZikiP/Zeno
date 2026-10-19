/**
 * 追漫：把该留的未读章节的原图铺到服务端盘上
 *
 * 分工：台账该有什么章由这一侧自己算（warm-ledger.mjs），地址表自己解
 * （warm-resolve.mjs），留多久自己判（warm-gc.mjs）。**不再依赖客户端打开详情页
 * 递交地址表** —— 那样"追"就变成了"我恰好点开过的那几章"，没人碰页面的那几天不推进。
 *
 * 为什么取字节走自己的 /api/proxy（回环自请求）而不是直接 fetch 上游：
 * 代理那三道闸（域名白名单、地址策略、逐跳重定向复检）加落盘必须**复用**而不是复制。
 * 复制出来的第二份取字节路径，迟早跟真那份在某个站上不一致，而预热跑在没人看着的后台，
 * 不一致的表现是"铺了但没铺上"，比不铺更难查。
 *
 * 三道限流都照实测来：
 *   - 单张并发 3：跟离线下载同一个数，再高上游 CDN 开始掐（src/store/chapters.ts）
 *   - 代理闸位过半、或渲染槽被用户占着就等：追漫不该把正在读的那几张挤到队列后面
 *   - 盘到上限就收工：继续铺只会让 LRU 把在读的图裁掉，越铺越慢
 */
import {
  bookLedger,
  claimRow,
  failRow,
  keepChapters,
  ledger,
  nextQueued,
  resumeRunning,
  saveKeepChapters,
  selfOrigin,
  selfToken,
  setSelf,
  settleRow,
} from './warm-store.mjs';
import { followedBooks, reconcileLedger } from './warm-ledger.mjs';
import { alreadyCached, totals } from './cache-store.mjs';
import { cacheMaxBytes, cacheOn } from './cache-config.mjs';
import { proxyLoad } from './proxy.mjs';
import { sweepWarm } from './warm-gc.mjs';
import { json, readBody } from './respond.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 同时取几张。跟 chapters.ts 的 DOWNLOAD_CONCURRENCY 同一个来源、同一个理由 */
const CONCURRENCY = Math.max(1, Number(process.env.ZENO_WARM_CONCURRENCY || 3));
/** 闸位被阅读器占到一半以上就等这一档再看 */
const BACKOFF_MS = Number(process.env.ZENO_WARM_BACKOFF_MS || 2000);
/** 一轮最多铺多久。剩下的留给下一轮，免得一次递交把机器钉住几十分钟 */
const ROUND_BUDGET_MS = Number(process.env.ZENO_WARM_ROUND_MS || 10 * 60_000);
/** 单张超时。CDN 偶尔挂住连接，不设超时整章会卡死 */
const IMAGE_TIMEOUT_MS = Number(process.env.ZENO_WARM_IMAGE_MS || 30_000);
/** 两轮之间的间隔 */
const LOOP_MS = Number(process.env.ZENO_WARM_LOOP_MS || 15 * 60_000);
/** 启动延迟：留给追更那一轮先跑完，别看两个后台任务同时抢闸 */
const START_DELAY_MS = Number(process.env.ZENO_WARM_START_DELAY_MS || 90_000);

let timer = null;
let pumping = false;
let lastRound = null;

/** 现在能不能铺。返回原因就该等一等，或者这轮收工 */
function blockedReason() {
  if (!cacheOn()) return 'cache-off';
  const max = cacheMaxBytes();
  if (max && totals().bytes >= max) return 'cache-full';
  const { active, max: slots } = proxyLoad();
  if (active >= Math.ceil(slots / 2)) return 'reader-busy';
  return null;
}

/**
 * 取一张并**读到底**。
 *
 * 代理是在流结束那一刻才提交落盘的（见 upstream.mjs），半路 abort 等于这张白取一趟。
 */
async function grab(upstreamUrl) {
  try {
    const res = await fetch(`${selfOrigin()}/api/proxy?url=${encodeURIComponent(upstreamUrl)}`, {
      headers: selfToken() ? { Authorization: `Bearer ${selfToken()}` } : {},
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    if (!res.ok) return 0;
    return (await res.arrayBuffer()).byteLength;
  } catch {
    return 0;
  }
}

/** 铺一章：定长工作池，单张失败不中断整章（少一张总比整章铺不完强） */
async function warmRow(row) {
  const images = JSON.parse(row.images);
  let got = 0;
  let bytes = 0;
  let failed = 0;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, images.length) }, async () => {
      while (cursor < images.length) {
        const url = images[cursor++];
        if (alreadyCached(url)) {
          got++;
          continue;
        }
        const n = await grab(url);
        if (n) {
          got++;
          bytes += n;
        } else {
          failed++;
        }
      }
    }),
  );
  const state = settleRow(row, { got, bytes, failed, error: failed ? `${failed} 张没取到` : null });
  return { state, got, bytes };
}

/**
 * 跑一轮：把 queued 铺掉。同一时刻只跑一轮，
 * 递交时那下 kick 撞上就立刻返回，让正在跑的那轮自己收尾。
 */
export async function runWarmRound() {
  if (pumping) return null;
  pumping = true;
  const startedAt = Date.now();
  const summary = { rows: 0, images: 0, bytes: 0, paused: null, resolved: 0 };
  try {
    /*
     * 先补齐台账再铺字节：追漫是服务端自己算"该有哪 K 章"的，
     * 上一轮读完的章这一轮就该被新的未读章顶上，不补就永远停在第一次那份表上。
     */
    const led = await reconcileLedger().catch(() => null);
    if (led) summary.resolved = led.resolved;
    for (;;) {
      const why = blockedReason();
      if (why === 'reader-busy') {
        // 用户在读：等一会儿再看，等到本轮预算用完为止
        if (Date.now() - startedAt > ROUND_BUDGET_MS) {
          summary.paused = why;
          break;
        }
        await sleep(BACKOFF_MS);
        continue;
      }
      if (why) {
        summary.paused = why;
        break;
      }
      if (Date.now() - startedAt > ROUND_BUDGET_MS) {
        summary.paused = 'budget';
        break;
      }
      const row = nextQueued();
      if (!row) break;
      claimRow(row);
      try {
        const r = await warmRow(row);
        summary.rows++;
        summary.images += r.got;
        summary.bytes += r.bytes;
      } catch (e) {
        // 地址表坏了一行不该让整轮作废
        failRow(row, e?.message ?? e);
      }
    }
    // 走到这里说明这轮没有正在跑的行；还停在 running 的都是上次崩在半路的
    resumeRunning();
  } finally {
    pumping = false;
    lastRound = { ...summary, at: startedAt };
  }
  return lastRound;
}

export function warmStatus() {
  const states = ledger();
  return {
    keep: keepChapters(),
    concurrency: CONCURRENCY,
    states,
    pending: (states.queued ?? 0) + (states.error ?? 0),
    pumping,
    cache: totals(),
    cacheMaxBytes: cacheMaxBytes(),
    lastRound,
  };
}

/* ── API ───────────────────────────────────────────── */

export async function handleWarmApi(req, res, url, auth) {
  const path = url.pathname;
  if (!path.startsWith('/api/warm')) return false;
  if (!auth(req)) {
    json(res, 401, { error: 'unauthorized' });
    return true;
  }

  try {
    if (path === '/api/warm' && req.method === 'GET') {
      json(res, 200, warmStatus());
      return true;
    }
    /*
     * 手动踢一轮。设置页那句"现在就铺"用，测试也用它 ——
     * 不然改完配置要干等 15 分钟才知道有没有生效。
     */
    if (path === '/api/warm/run' && req.method === 'POST') {
      json(res, 200, { ok: true, round: await runWarmRound() });
      return true;
    }
    /*
     * 一本书的台账。详情页拿它给章节挂"已缓存"标记 —— 只有服务端知道
     * 哪几章的字节真在盘上，客户端那份 IndexedDB 记的是别的事。
     */
    if (path === '/api/warm/book' && req.method === 'GET') {
      const pluginId = url.searchParams.get('pluginId') ?? '';
      const slug = url.searchParams.get('slug') ?? '';
      if (!pluginId || !slug || pluginId.includes('/') || slug.includes('/')) {
        json(res, 400, { error: '要 query 参数 pluginId 和 slug（都不带 /）' });
        return true;
      }
      json(res, 200, { keep: keepChapters(), chapters: bookLedger(pluginId, slug) });
      return true;
    }
    if (path === '/api/warm/keep' && req.method === 'POST') {
      const body = await readBody(req, 8 * 1024);
      json(res, 200, { ok: true, keep: saveKeepChapters(body?.keep) });
      return true;
    }
    /*
     * 手动扫一次保留策略。设置页改完 K 之后客户端叫这一下，
     * 不然新口径要等到下一轮（默认 15 分钟）才生效。
     */
    if (path === '/api/warm/sweep' && req.method === 'POST') {
      json(res, 200, { ok: true, ...(await sweepWarm(followedBooks())) });
      return true;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, e.status ?? 400, { error: e.message });
  }
  return true;
}

/* ── 常驻循环 ──────────────────────────────────────── */

/**
 * 起循环。启动时先把上次崩在半路的行重新排上队 ——
 * 不做这一步的话它们永远停在 running，而界面上看就是"这本一直在铺"。
 */
export function startWarmLoop({ port, token } = {}) {
  setSelf({ origin: port ? `http://127.0.0.1:${Number(port)}` : selfOrigin(), token: token ?? selfToken() });
  resumeRunning();
  if (LOOP_MS <= 0) return null;
  const info = { keep: keepChapters(), loopMs: LOOP_MS, startDelayMs: START_DELAY_MS };
  const tick = async () => {
    try {
      await sweepWarm(followedBooks());
      await runWarmRound();
    } catch {
      /* 后台循环的失败不惊动用户：下一轮自己再来 */
    }
  };
  const repeat = () => {
    timer = setTimeout(async () => {
      await tick();
      repeat();
    }, LOOP_MS);
    timer.unref?.();
  };
  timer = setTimeout(async () => {
    await tick();
    repeat();
  }, START_DELAY_MS);
  timer.unref?.();
  return info;
}

export function stopWarmLoop() {
  if (timer) clearTimeout(timer);
  timer = null;
}
