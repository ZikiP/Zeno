/**
 * Zeno 服务端
 *
 * 一个进程同时做三件事，省得在 MiniPC 上跑多个服务：
 *   1. 静态文件  —— 托管 dist/，SPA 路由回退
 *   2. 同步 API  —— 书架 / 进度 / 书签 / 插件 / 偏好 的多端同步
 *   3. 抓取代理  —— 解决目标站点的 CORS 问题
 *
 * ## 访问方式（重要）
 *
 * 必须用 `tailscale serve` 拿 HTTPS，不能直接用 http://mini-pc:8788。
 * 原因：浏览器只在「安全上下文」（HTTPS 或 localhost）下启用 Service Worker。
 * 用 MagicDNS 名 + http 访问虽然能通，但 PWA 的离线缓存会静默失效。
 *
 *   tailscale serve --bg 8788
 *   # 拿到 https://<机器名>.<tailnet>.ts.net/
 *
 * ## 启动
 *
 *   node server/index.mjs
 *
 * 环境变量：
 *   PORT            监听端口，默认 8788
 *   DIST_DIR        静态目录，默认 ./dist
 *   DB_PATH         SQLite 路径，默认 ./data/zeno.db
 *   ALLOWED_HOSTS   抓取代理的白名单，逗号分隔。不设置则拒绝一切
 *   MAX_CONCURRENT  上游并发上限，默认 6
 *   SYNC_TOKEN      可选。设置后同步 API 需要 Bearer token
 */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';

import { openDb, pull, saveClientState, stats, listClients } from './db.mjs';
import { pushAll } from './merge.mjs';
import { resolveStatic, sendFile, isHashedAsset } from './static.mjs';

const PORT = Number(process.env.PORT || 8788);
const DIST_DIR = resolve(process.env.DIST_DIR || './dist');
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';

/* ── 抓取代理配置 ─────────────────────────────────── */

const ALLOWED = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

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

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

if (ALLOWED.length === 0) {
  console.warn('[zeno] 提示：未设置 ALLOWED_HOSTS，抓取代理会拒绝一切请求。');
}

/* ── 小工具 ───────────────────────────────────────── */

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(s);
}

async function readBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error('payload too large');
    chunks.push(c);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function auth(req) {
  if (!SYNC_TOKEN) return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${SYNC_TOKEN}`;
}

/* ── 请求处理 ─────────────────────────────────────── */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  try {
    /* ── CORS 预检 ── */
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    /* ── 健康检查 / 状态 ── */
    if (path === '/api/health') {
      json(res, 200, { ok: true, version: 1, ...stats() });
      return;
    }

    if (path === '/api/sync/clients') {
      if (!auth(req)) return json(res, 401, { error: 'unauthorized' });
      json(res, 200, { clients: listClients() });
      return;
    }

    /* ── 同步：拉取 ── */
    if (path === '/api/sync/pull' && req.method === 'GET') {
      if (!auth(req)) return json(res, 401, { error: 'unauthorized' });
      const since = Number(url.searchParams.get('since') ?? 0);
      const deviceId = url.searchParams.get('deviceId') ?? 'unknown';
      const data = pull(Number.isFinite(since) ? since : 0);
      saveClientState(
        deviceId,
        data.seq,
        req.headers['user-agent']?.slice(0, 200) ?? null,
      );
      json(res, 200, data);
      return;
    }

    /* ── 同步：推送 ── */
    if (path === '/api/sync/push' && req.method === 'POST') {
      if (!auth(req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const deviceId = body.deviceId ?? req.headers['x-device-id'] ?? 'unknown';
      const result = pushAll(body, deviceId);
      saveClientState(deviceId, body.seq ?? 0, req.headers['user-agent']?.slice(0, 200) ?? null);
      json(res, 200, { ok: true, applied: result, serverSeq: stats().seq });
      return;
    }

    /* ── 抓取代理 ── */
    if (path === '/api/proxy') {
      const target = url.searchParams.get('url');
      if (!target) return json(res, 400, { error: 'missing url' });

      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        return json(res, 400, { error: 'bad url' });
      }

      const host = parsed.hostname.toLowerCase();
      // 白名单：精确相等或子域名。防止被当成开放代理
      const ok = ALLOWED.some((a) => host === a || host.endsWith(`.${a}`));
      if (!ok) {
        json(res, 403, { error: 'host not allowed', host });
        return;
      }

      await acquire();
      let released = false;
      try {
        let upstream;
        let lastErr;
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
          if (!released) {
            released = true;
            release();
          }
        });
        res.on('close', () => {
          if (!res.writableEnded) src.destroy();
        });
        res.on('error', () => src.destroy());
        src.pipe(res);
      } catch (e) {
        res.writeHead(502).end(`upstream failed: ${e.message}`);
      } finally {
        released = true;
        release();
      }
      return;
    }

    /* ── 静态文件 ── */
    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = resolveStatic(DIST_DIR, path);
      if (file) {
        sendFile(res, file, { immutable: isHashedAsset(path) });
        return;
      }
      // SPA 回退：前端用 History 路由，深链接要能直接打开
      const index = resolveStatic(DIST_DIR, '/index.html');
      if (index) {
        sendFile(res, index);
        return;
      }
      json(res, 404, {
        error: 'dist not found',
        hint: '先跑 npm run build',
      });
      return;
    }

    json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    console.error('[zeno] request failed:', e);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

/* ── 启动 ─────────────────────────────────────────── */

// 长驻进程：任何意外都不该让它整个消失
process.on('uncaughtException', (err) => {
  console.error('[zeno] uncaught exception (继续运行):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[zeno] unhandled rejection (继续运行):', reason);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[zeno] 端口 ${PORT} 被占用。换一个：PORT=9000 node server/index.mjs`);
  } else {
    console.error('[zeno] server error:', err.message);
  }
  process.exit(1);
});

openDb();

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log(`  Zeno 服务已启动`);
  console.log(`  ├─ 本机     http://127.0.0.1:${PORT}`);
  console.log(`  ├─ 局域网   http://<本机IP>:${PORT}`);
  console.log(`  ├─ 静态目录 ${DIST_DIR}`);
  console.log(`  ├─ 数据库   ${process.env.DB_PATH || './data/zeno.db'}`);
  console.log(`  ├─ 代理白名单 ${ALLOWED.join(', ') || '(未设置 — 抓取会被拒绝)'}`);
  console.log(`  └─ 同步令牌 ${SYNC_TOKEN ? '已启用' : '未设置（仅靠 tailnet 保护）'}`);
  console.log('');
  console.log('  远程访问请用 Tailscale Serve 拿 HTTPS（否则 PWA 离线失效）：');
  console.log(`    tailscale serve --bg ${PORT}`);
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[zeno] ${sig} 收到，退出`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
