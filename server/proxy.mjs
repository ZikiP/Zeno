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
 */
import { Readable } from 'node:stream';
import { assertPublicTarget } from './ssrf.mjs';
import { renderHtml } from './render.mjs';
import { hostAllowed } from './allowlist.mjs';
import { json } from './respond.mjs';
import { collector, IMG_CACHE_CONTROL, isImage, lookup, serveCached } from './cache.mjs';

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
/** 放行解析到内网/回环的目标。只给本地测试用，生产不该开 */
const ALLOW_PRIVATE_HOSTS = process.env.ALLOW_PRIVATE_HOSTS === '1';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 20_000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 6);

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
        timeoutMs: Number(url.searchParams.get('timeoutMs')) || undefined,
        userAgent: req.headers['user-agent'],
      });
      res.writeHead(r.status, {
        ...CORS,
        'Content-Type': r.contentType,
        'Cache-Control': 'no-store', // 渲染结果有时效且不幂等，别让 SW/CDN 缓存
      });
      res.end(req.method === 'HEAD' ? undefined : r.html);
      return;
    }

    /*
     * 重定向必须逐跳自己跟、自己校验。
     * 交给 fetch 的 redirect:'follow' 等于开后门 —— 白名单域名只要回一个
     * 302 → http://127.0.0.1:8788/ 就绕过了域名白名单和地址策略两道闸。
     * 反过来直接透传 3xx 也不行：客户端会自己去跟，撞 CORS 且绕过代理。
     */
    const MAX_HOPS = 5;
    let current = parsed;
    let upstream;
    let lastErr;

    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const again = await assertPublicTarget(current, { allowPrivate: ALLOW_PRIVATE_HOSTS });
      if (!again.ok) {
        return json(res, 403, {
          error: 'blocked address',
          host: current.hostname,
          reason: `重定向目标被拒：${again.reason}`,
        });
      }
      const hopHost = current.hostname.toLowerCase();
      if (!hostAllowed(hopHost)) {
        return json(res, 403, {
          error: 'host not allowed',
          host: hopHost,
          hint: '上游把请求重定向到了白名单外的域名，已拒绝跟随。',
        });
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          upstream = await fetch(current.toString(), {
            headers: {
              'User-Agent': MOBILE_UA,
              Accept: req.headers.accept ?? '*/*',
              'Accept-Language': 'zh-TW,zh;q=0.9',
            },
            redirect: 'manual',
            /*
             * 必须有超时。之前没有，一个挂死的上游连接会永久占着
             * MAX_CONCURRENT 六分之一的名额 —— 几个之后整个代理就"看起来卡死"，
             * 而且没有任何报错可看。
             */
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
          if (upstream.ok || upstream.status < 500) break;
          lastErr = new Error(`HTTP ${upstream.status}`);
        } catch (e) {
          lastErr = e;
        }
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
      if (!upstream) throw lastErr ?? new Error('upstream unavailable');

      const loc = upstream.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(upstream.status) && loc) {
        try {
          current = new URL(loc, current);
        } catch {
          break; // 非法 Location，就把 3xx 原样回给客户端
        }
        upstream = undefined; // 强制下一跳重新取
        continue;
      }
      break;
    }
    if (!upstream) throw lastErr ?? new Error('重定向次数过多');

    const headers = {
      ...CORS,
      'Cache-Control': 'public, max-age=600',
    };
    const ct = upstream.headers.get('content-type');
    if (ct) headers['Content-Type'] = ct;
    /*
     * 图片给一天（本地还有盘上的副本兜着），HTML 保持十分钟：
     * 章节列表放一天，用户会以为上游没更新。
     */
    if (isImage(ct)) headers['Cache-Control'] = IMG_CACHE_CONTROL;

    res.writeHead(upstream.status, headers);
    if (!upstream.body || req.method === 'HEAD') {
      res.end();
      return;
    }

    /*
     * 流式转发必须挂 error 监听。
     * CDN 中途断连（UND_ERR_SOCKET）时 pipe 会抛 error，
     * Node 默认对 Readable 的 error 做 throw，没监听就直接终止进程。
     * 实测踩过：代理跑着跑着整个消失，所有请求变 502。
     */
    const src = Readable.fromWeb(upstream.body);
    /*
     * 顺手攒一份进磁盘缓存。攒在内存里而不是同时写文件：
     * 双写要自己管两个下游的背压，谁慢都会饿着另一个，出错时还容易只清掉一半。
     * 单张上限 8MB、并发 6，最坏占 48MB，换掉的是那一整类 bug。
     * 客户端中途断开时 'end' 不会触发，于是半张图不会被存进去。
     */
    const sink = upstream.ok && isImage(ct) ? collector(cacheKey, ct) : null;
    if (sink) {
      src.on('data', (c) => sink.push(c));
      src.on('end', () => void sink.commit());
    }
    src.on('error', (err) => {
      console.warn(`[zeno] upstream aborted: ${err.message}`);
      if (!res.headersSent) res.writeHead(502).end('upstream aborted');
      else res.end();
      done();
    });
    res.on('close', () => {
      if (!res.writableEnded) src.destroy();
    });
    res.on('error', () => src.destroy());
    src.pipe(res);
  } catch (e) {
    const status = e.code === 'NO_BROWSER' ? 503 : e.code === 'BUSY' ? 429 : 502;
    const body = JSON.stringify({ error: e.message, code: e.code ?? 'upstream_failed' });
    if (!res.headersSent) {
      res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
    }
    res.end(body);
  } finally {
    done();
  }
}
