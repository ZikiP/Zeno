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
 *   ALLOW_PRIVATE_HOSTS
 *                   可选。设 1 时放行解析到内网/回环的目标，仅供本地开发与测试。
 *                   默认关闭 —— 生产环境不该开。
 *   ZENO_BROWSER    可选。fetch.mode="browser" 用的浏览器可执行文件路径；
 *                   不设则自动探测 ms-playwright 缓存 / Edge / Chrome。
 */
import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { openDb, pull, saveClientState, stats, listClients, allowedHostsFromPlugins } from './db.mjs';
import { pushAll, removePlugin } from './merge.mjs';
import { resolveStatic, sendFile, isHashedAsset } from './static.mjs';
import { handleProxy } from './proxy.mjs';

const PORT = Number(process.env.PORT || 8788);
const DIST_DIR = resolve(process.env.DIST_DIR || './dist');
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const ALLOW_PRIVATE_HOSTS = process.env.ALLOW_PRIVATE_HOSTS === '1';

/* ── 抓取代理配置 ─────────────────────────────────── */

/**
 * 白名单 = 已安装插件推导出的域名 ∪ 环境变量补充。
 *
 * 主要来源是插件：用户在应用里装好插件，白名单自动生效，
 * 不需要再去改环境变量、重启服务。同一份信息不填两遍。
 * ALLOWED_HOSTS 只作为「还没装插件就想先调代理」时的补充手段。
 */
const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

let allowed = new Set();

/** 从数据库重新推导白名单。插件变动后调它。返回数组（JSON 可序列化） */
function refreshAllowed() {
  const fromPlugins = allowedHostsFromPlugins();
  allowed = new Set([...EXTRA_HOSTS, ...fromPlugins]);
  return [...allowed];
}

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
      json(res, 200, {
        ok: true,
        version: 1,
        ...stats(),
        // 白名单放在状态里，排查「装插件了却抓不到」时一眼能看出原因
        allowedHosts: [...allowed],
      });
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

      /*
       * 插件变了，白名单跟着变。
       * 不刷新的话，用户在手机上装好插件后，家里 MiniPC 的代理还是拒绝该站点，
       * 表现是「明明装了插件还是抓不到」—— 很难自己想到跟白名单有关。
       *
       * 注意 refreshAllowed 返回的是 Set，要展开成数组才能 JSON 序列化，
       * 否则客户端拿到的是 {}。
       */
      refreshAllowed();

      json(res, 200, {
        ok: true,
        applied: result,
        serverSeq: stats().seq,
        allowedHosts: [...allowed],
      });
      return;
    }

    /* ── 同步：删除插件（删除也要传播到其他设备） ── */
    if (path === '/api/sync/forget-plugin' && req.method === 'POST') {
      if (!auth(req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const id = String(body.id ?? '');
      if (!id) return json(res, 400, { error: 'missing id' });

      const removed = removePlugin(id, body.deviceId ?? 'unknown');
      refreshAllowed();

      json(res, 200, { ok: true, removed, allowedHosts: [...allowed] });
      return;
    }

    /* ── 抓取代理 ── */
    if (path === '/api/proxy') {
      const ctx = { allowed, acquire, release, json, mobileUa: MOBILE_UA, allowPrivateHosts: ALLOW_PRIVATE_HOSTS };
      await handleProxy(req, res, url, ctx);
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
refreshAllowed();

server.listen(PORT, '0.0.0.0', () => {
  const n = allowed.size;
  console.log('');
  console.log('  Zeno 服务已启动');
  console.log(`  ├─ 本机      http://127.0.0.1:${PORT}`);
  console.log(`  ├─ 局域网    http://<本机IP>:${PORT}`);
  console.log(`  ├─ 静态目录  ${DIST_DIR}`);
  console.log(`  ├─ 数据库    ${process.env.DB_PATH || './data/zeno.db'}`);
  console.log(
    `  ├─ 抓取白名单 ${n ? `${n} 个（来自已安装的插件）` : '空 — 装个插件就会自动放行对应站点'}`,
  );
  console.log(`  └─ 同步令牌  ${SYNC_TOKEN ? '已启用' : '未设置（仅靠 tailnet 保护）'}`);
  if (n > 0) {
    console.log('');
    console.log('     已放行：' + [...allowed].join(', '));
  }
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
