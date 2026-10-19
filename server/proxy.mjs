/**
 * 抓取代理
 *
 * 从 index.mjs 抽出来有两个原因：index.mjs 本来就超了 300 行的服务文件上限，
 * 再往里塞渲染分支只会更糟；另外 README 一直写着部署时要挂 `server/proxy.mjs`，
 * 实际却没有这个文件 —— 抽出来正好对上。
 *
 * 三道闸，顺序不能换：
 *   1. 域名白名单（从已装插件自动推导）—— 挡掉任意 URL 转发
 *   2. 地址策略 ssrf.mjs —— 挡掉"白名单域名解析到内网"
 *   3. 并发闸 acquire/release —— 挡掉把服务打满
 *
 * 放行之后怎么取、怎么转，在 upstream.mjs（逐跳重定向也在那边校验）。
 */
import { assertPublicTarget } from './ssrf.mjs';
import { renderHtml } from './render.mjs';
import { hostAllowed, headersFor } from './allowlist.mjs';
import { json } from './respond.mjs';
import { lookup } from './cache-store.mjs';
import { serveCached } from './cache.mjs';
import { pipeUpstream } from './upstream.mjs';

/** 放行解析到内网/回环的目标。只给本地测试用，生产不该开 */
const ALLOW_PRIVATE_HOSTS = process.env.ALLOW_PRIVATE_HOSTS === '1';
/*
 * 实测同一批章节图（21 张 / 6.8 MB）直连 CDN 的吞吐：
 * 并发 1 → 0.69 MB/s，4 → 2.5，8 → 4.0，16 → 4.06 —— 8 就已经撞到上行天花板，
 * 再往上加只会让每张图都变慢一点、总数不变。所以默认值取 8，不多取。
 */
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 8);

let active = 0;
const waiters = [];
function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((r) => waiters.push(r));
}
function release() {
  active--;
  waiters.shift()?.();
}

/**
 * 代理此刻的占用。给预热用的：它跟"用户正在读的那几张"走同一条闸，
 * 抢满就等于把阅读器拖到队列后面（实测一次长章节能占几十张）。
 */
export function proxyLoad() {
  return { active, max: MAX_CONCURRENT };
}

const CORS = {
  // 代理只被同源的 PWA 用（开发期由 vite 把 /api 转发过来），
  // 原来这里的 Access-Control-Allow-Origin: * 是不需要的，
  // 它让任意网页都能把这个服务当白名单中继来驱动。
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
};

export async function handleProxy(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target) return json(res, 400, { error: 'missing url' });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json(res, 400, { error: 'bad url' });
  }

  const host = parsed.hostname.toLowerCase();
  if (!hostAllowed(host)) {
    return json(res, 403, {
      error: 'host not allowed',
      host,
      hint: '装上对应内容的插件后会自动放行；也可以设 ALLOWED_HOSTS 手动补充',
    });
  }

  const guard = await assertPublicTarget(parsed, { allowPrivate: ALLOW_PRIVATE_HOSTS });
  if (!guard.ok) {
    return json(res, 403, {
      error: 'blocked address',
      host,
      reason: guard.reason,
      hint: '抓取代理只允许访问公网地址。本地测试需要放行时设 ALLOW_PRIVATE_HOSTS=1。',
    });
  }

  const mode = url.searchParams.get('mode') === 'browser' ? 'browser' : 'fetch';
  const cacheKey = parsed.toString();
  /** 这个域名属于哪个插件、它要求站点看到什么头 */
  const ph = headersFor(host);

  /*
   * 图片先问本地盘，命中就不回上游 —— 这才是这个缓存的意义：
   * 重读一章几十张图，一张都不用再去 CDN 排队。
   *
   * 放在三道闸之后：白名单撤掉（卸了插件）的站点，不该还能从盘上把内容端出来。
   * 也只有当初按 image/* 存进去的 URL 可能命中，列表页和详情页的 HTML 不会被误伤。
   */
  if (mode === 'fetch') {
    const hit = lookup(cacheKey);
    if (hit) {
      serveCached(res, hit, req.method, CORS);
      return;
    }
  }

  /*
   * 并发闸只给 fetch 模式用。
   * browser 模式自己已经有 MAX_PAGES 限流，而且一次渲染要好几秒 ——
   * 让它占住 MAX_CONCURRENT 六个槽之一，阅读器同时发的几十张图片就会
   * 全部排在渲染后面（实测单张图从 1~2s 被拖到 10s+）。
   */
  let held = false;
  if (mode === 'fetch') {
    await acquire();
    held = true;
  }
  const done = () => {
    if (held) {
      held = false;
      release();
    }
  };

  try {
    if (mode === 'browser') {
      const r = await renderHtml(parsed.toString(), {
        waitFor: url.searchParams.get('waitFor') || undefined,
        minCount: Number(url.searchParams.get('minCount')) || undefined,
        capture: url.searchParams.get('capture') || undefined,
        timeoutMs: Number(url.searchParams.get('timeoutMs')) || undefined,
        userAgent: ph['user-agent'] ?? req.headers['user-agent'],
      });
      /*
       * 从 JSON 里抓到整张表时回 JSON，不再把那份一个字节都用不上的 HTML 传下去：
       * 实测一次长章节的 HTML 有 75 KB，而真正要用的图片地址表只有 5 KB。
       * 抓空了 renderHtml 自己回落取 HTML，这里就照旧回 HTML —— 解析层还能
       * 按 parse.imageAttr 的老路再试一次，一个站点的两种形态都能读。
       */
      if (r.format === 'json') {
        /*
         * 不能用 respond.mjs 的 json() —— 它带 Access-Control-Allow-Origin: *。
         * 这个端点只能被同源 PWA 用：一旦允许跨源读，任意网页都能拿本服务
         * 当白名单中继，把已装插件域名的数据读走（上面 CORS 那段注释写的就是它）。
         */
        const body = JSON.stringify({ images: r.captured });
        res.writeHead(r.status, {
          ...CORS,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      res.writeHead(r.status, {
        ...CORS,
        'Content-Type': r.contentType,
        'Cache-Control': 'no-store', // 渲染结果有时效且不幂等，别让 SW/CDN 缓存
      });
      res.end(req.method === 'HEAD' ? undefined : r.html);
      return;
    }

    await pipeUpstream({
      req,
      res,
      target: parsed,
      pluginHeaders: ph,
      cacheKey,
      cors: CORS,
      release: done,
    });
  } catch (e) {
    /*
     * CHALLENGE 和 NO_BROWSER 都是"过一会儿再来可能就有了"，所以同样 503，
     * 但只给质询加 Retry-After：让客户端别立刻重试，重试也解不开，反而
     * 把自己坐实成机器人。
     */
    const status = e.code === 'NO_BROWSER' || e.code === 'CHALLENGE' ? 503 : e.code === 'BUSY' ? 429 : 502;
    const body = JSON.stringify({ error: e.message, code: e.code ?? 'upstream_failed' });
    if (!res.headersSent) {
      res.writeHead(
        status,
        e.code === 'CHALLENGE'
          ? { ...CORS, 'Content-Type': 'application/json', 'Retry-After': '30' }
          : { ...CORS, 'Content-Type': 'application/json' },
      );
    }
    res.end(body);
  } finally {
    done();
  }
}
