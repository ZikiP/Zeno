/**
 * 极简反向代理 —— 解决目标站点的 CORS 问题
 *
 * 多数站点不返回 Access-Control-Allow-Origin，浏览器直连必然被拦。
 * 本服务原样转发请求并补上 CORS 头。
 *
 * 站点白名单从环境变量读取，**不内置任何具体站点**：
 *   ALLOWED_HOSTS=example.com,cdn.example.com node server/proxy.mjs
 * 不设置则拒绝一切请求，避免变成开放代理。
 *
 * 用法：
 *   node server/proxy.mjs
 *   PORT=9000 ALLOWED_HOSTS=a.com,b.com node server/proxy.mjs
 *
 * 部署时：把 dist/ 交给任意静态服务器，把本服务挂在同一域名下的 /api 路径即可。
 */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PORT || 8788);

/** 允许访问的上游域名白名单 —— 由使用者通过环境变量提供 */
const ALLOWED = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const MAX_CONCURRENT_DEFAULT = 6;

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

if (ALLOWED.length === 0) {
  console.warn('[proxy] 警告：未设置 ALLOWED_HOSTS，所有请求都会被拒绝。');
  console.warn('[proxy] 用法：ALLOWED_HOSTS=example.com,cdn.example.com node server/proxy.mjs');
}

/**
 * 上游并发限制。
 * 实测浏览器一次并发 38 张封面会把站点 CDN 打挂（部分返回非 200，图片裂开），
 * 串行则 12/12 全 200。这里做信号量，把并发压到 6 —— 仍比串行快得多，且不触发限流。
 */
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 6);
let active = 0;
const waiters = [];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((res) => waiters.push(res));
}

function release() {
  active--;
  const next = waiters.shift();
  if (next) {
    active++;
    next();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // 接口：/api/proxy?url=<上游地址>
  if (url.pathname === '/api/proxy') {
    const target = url.searchParams.get('url');
    if (!target) {
      res.writeHead(400).end('missing url');
      return;
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      res.writeHead(400).end('bad url');
      return;
    }

    // 白名单匹配：精确相等，或为白名单项的子域名
    const host = parsed.hostname.toLowerCase();
    const ok = ALLOWED.some((a) => host === a || host.endsWith(`.${a}`));
    if (!ok) {
      res.writeHead(403).end('host not allowed');
      return;
    }

    await acquire();
    try {
      let upstream;
      let lastErr;
      // 上游偶发 5xx/连接重置，重试两次
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          upstream = await fetch(parsed.toString(), {
            headers: {
              'User-Agent': MOBILE_UA,
              Accept: req.headers.accept ?? '*/*',
              'Accept-Language': 'zh-TW,zh;q=0.9',
            },
            redirect: 'follow',
          });
          if (upstream.ok || upstream.status < 500) break;
          lastErr = new Error(`HTTP ${upstream.status}`);
        } catch (e) {
          lastErr = e;
        }
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
      if (!upstream) throw lastErr ?? new Error('upstream unavailable');

      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Cache-Control': 'public, max-age=600',
      };

      const ct = upstream.headers.get('content-type');
      if (ct) headers['Content-Type'] = ct;

      res.writeHead(upstream.status, headers);

      if (!upstream.body || req.method === 'HEAD') {
        res.end();
        return;
      }
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) {
      res.writeHead(502).end(`upstream failed: ${e.message}`);
    } finally {
      release();
    }
    return;
  }

  // 静态文件（生产部署时用）
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }).end('ok');
    return;
  }

  res.writeHead(404).end('not found');
});

server.listen(PORT, () => {
  console.log(`[proxy] listening on http://0.0.0.0:${PORT}`);
  console.log(`[proxy] allowed hosts: ${ALLOWED.join(', ')}`);
});
