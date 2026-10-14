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
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';

import { openDb, pull, saveClientState, stats, listClients, allowedHostsFromPlugins } from './db.mjs';
import { pushAll } from './merge.mjs';
import { removePlugin } from './deletes.mjs';
import { resolveStatic, sendFile, isHashedAsset } from './static.mjs';
import { handleProxy } from './proxy.mjs';

const PORT = Number(process.env.PORT || 8788);
const DIST_DIR = resolve(process.env.DIST_DIR || './dist');
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const ALLOW_PRIVATE_HOSTS = process.env.ALLOW_PRIVATE_HOSTS === '1';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 20_000);

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
  let tooLarge = false;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) {
      /*
       * 超限后不能直接 throw —— 请求体还没被读完就回响应，Node 会重置连接，
       * 复用同一 socket 的下一个请求就拿到 ECONNRESET（实测踩过：
       * 413 用例自己把后面的用例打挂了）。
       * 正确做法是继续把剩下的排空但不再缓存，读完才报错。
       */
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(c);
  }
  if (tooLarge) {
    throw Object.assign(new Error('payload too large'), { status: 413 });
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function auth(req) {
  if (!SYNC_TOKEN) return true;
  const h = req.headers.authorization ?? '';
  return tokenEquals(h, `Bearer ${SYNC_TOKEN}`);
}

/**
 * 定长比较 + timingSafeEqual。
 * 用 === 比较令牌的耗时随前缀相同长度增长，理论上可被计时攻击逐字节猜。
 * 本机自用威胁模型下几乎不可利用，但正确写法并不更贵。
 */
function tokenEquals(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false; // 长度本身不敏感
  return timingSafeEqual(ba, bb);
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
      const s = stats();
      /*
       * 公开字段只到"活着没有"。dbPath 是绝对路径、allowedHosts 等于
       * 在告诉任何能连上这个端口的人"你在读哪些站点" —— 这两个只在带令牌时给。
       * 计数保留公开，部署脚本的健康检查要用，而且本身不敏感。
       */
      const body = { ok: true, version: 1, ...s, allowedHostsCount: allowed.size };
      if (auth(req)) {
        body.allowedHosts = [...allowed];
      } else {
        delete body.dbPath;
      }
      json(res, 200, body);
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
      /*
       * 代理必须和其它端点一样过鉴权。
       * 它只靠域名白名单挡不住什么：白名单是从"装过哪些插件"推导的，
       * 而设了 SYNC_TOKEN 的人默认以为整个服务都有令牌保护 ——
       * 之前恰恰是这个端点漏了 auth()，等于留了一个免票的开放中继。
       */
      if (!auth(req)) return json(res, 401, { error: 'unauthorized' });
      const ctx = {
        allowed, acquire, release, json,
        mobileUa: MOBILE_UA,
        allowPrivateHosts: ALLOW_PRIVATE_HOSTS,
        upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
      };
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
      /*
       * 带扩展名的路径不要回退到 index.html。
       * History 路由的 URL 没有扩展名，所以"像文件的路径"就是资源请求 ——
       * 回退成 HTML 会让浏览器把 HTML 当 JS 模块解析，
       * 报 "Expected a JavaScript module script but the server responded
       * with a MIME type of text/html" 然后白屏，且极难归因。
       * 404 才是能被看懂的失败。
       */
      const looksLikeAsset = /\.[A-Za-z0-9]{2,8}$/.test(path);
      if (!looksLikeAsset) {
        const index = resolveStatic(DIST_DIR, '/index.html');
        if (index) {
          sendFile(res, index);
          return;
        }
      }
      json(res, 404, looksLikeAsset
        ? { error: 'not found', hint: '资源不存在。多半是前端重新构建后旧缓存还在引用已删除的文件。' }
        : { error: 'dist not found', hint: '先跑 npm run build' });
      return;
    }

    json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    console.error('[zeno] request failed:', e);
    if (!res.headersSent) json(res, e.status ?? 500, { error: e.message });
    else res.end();
  }
});

/* ── 启动 ─────────────────────────────────────────── */

/*
 * 长驻进程不该因为一个意外就整个消失 —— 保留兜底。
 * 但只打 err.message 会把真实缺陷压成一行看不懂的日志（之前就是这样）。
 * 改成打完整堆栈，并且不吞 unhandledRejection 的原因对象。
 */
process.on('uncaughtException', (err) => {
  console.error('[zeno] uncaught exception（继续运行，但这是 bug）:');
  console.error(err.stack ?? err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[zeno] unhandled rejection（继续运行，但这是 bug）:');
  console.error(reason instanceof Error ? (reason.stack ?? reason) : reason);
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
