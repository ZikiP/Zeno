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

const CORS = {
  // 代理只被同源的 PWA 用（开发期由 vite 把 /api 转发过来），
  // 原来这里的 Access-Control-Allow-Origin: * 是不需要的，
  // 它让任意网页都能把这个服务当白名单中继来驱动。
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
};

export async function handleProxy(req, res, url, ctx) {
  const { allowed, acquire, release, json } = ctx;

  const target = url.searchParams.get('url');
  if (!target) return json(res, 400, { error: 'missing url' });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json(res, 400, { error: 'bad url' });
  }

  const host = parsed.hostname.toLowerCase();
  const ok = [...allowed].some((a) => host === a || host.endsWith(`.${a}`));
  if (!ok) {
    return json(res, 403, {
      error: 'host not allowed',
      host,
      hint: '装上对应内容的插件后会自动放行；也可以设 ALLOWED_HOSTS 手动补充',
      allowed: [...allowed],
    });
  }

  const guard = await assertPublicTarget(parsed, { allowPrivate: ctx.allowPrivateHosts });
  if (!guard.ok) {
    return json(res, 403, {
      error: 'blocked address',
      host,
      reason: guard.reason,
      hint: '抓取代理只允许访问公网地址。本地测试需要放行时设 ALLOW_PRIVATE_HOSTS=1。',
    });
  }

  const mode = url.searchParams.get('mode') === 'browser' ? 'browser' : 'fetch';

  await acquire();
  let released = false;
  const done = () => {
    if (!released) {
      released = true;
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
      const again = await assertPublicTarget(current, { allowPrivate: ctx.allowPrivateHosts });
      if (!again.ok) {
        return json(res, 403, {
          error: 'blocked address',
          host: current.hostname,
          reason: `重定向目标被拒：${again.reason}`,
        });
      }
      const hopHost = current.hostname.toLowerCase();
      if (![...allowed].some((a) => hopHost === a || hopHost.endsWith(`.${a}`))) {
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
              'User-Agent': ctx.mobileUa,
              Accept: req.headers.accept ?? '*/*',
              'Accept-Language': 'zh-TW,zh;q=0.9',
            },
            redirect: 'manual',
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
