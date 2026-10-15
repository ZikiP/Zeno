/**
 * Zeno 服务端
 *
 * 一个进程同时做三件事，省得在 MiniPC 上跑多个服务：
 *   1. 静态文件  —— 托管 dist/，SPA 路由回退
 *   2. 同步 API  —— 书架 / 进度 / 书签 / 插件 / 偏好 的多端同步（sync-api.mjs）
 *   3. 抓取代理  —— 解决目标站点的 CORS 问题（proxy.mjs）
 *
 * 这里只留「请求归谁」和启动。要加端点的话，多半该加在对应模块里。
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
 * 环境变量见 README 的「生产部署」一节。
 */
import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { openDb } from './db.mjs';
import { allowedHosts, refreshAllowed } from './allowlist.mjs';
import { handleSyncApi } from './sync-api.mjs';
import { handleProxy } from './proxy.mjs';
import { handleCacheApi } from './cache.mjs';
import { cacheDir, cacheMaxBytes } from './cache-config.mjs';
import { reconcile } from './cache-store.mjs';
import { resolveStatic, sendFile, isHashedAsset } from './static.mjs';
import { json, makeAuth } from './respond.mjs';

const PORT = Number(process.env.PORT || 8788);
const DIST_DIR = resolve(process.env.DIST_DIR || './dist');
const auth = makeAuth(process.env.SYNC_TOKEN || '');

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

    /* ── 同步与状态 API ── */
    if (await handleSyncApi(req, res, url, auth)) return;

    /* ── 图片缓存的管理 API ── */
    if (await handleCacheApi(req, res, url, auth)) return;

    /* ── 抓取代理 ── */
    if (path === '/api/proxy') {
      /*
       * 代理必须和其它端点一样过鉴权。
       * 它只靠域名白名单挡不住什么：白名单是从"装过哪些插件"推导的，
       * 而设了 SYNC_TOKEN 的人默认以为整个服务都有令牌保护 ——
       * 之前恰恰是这个端点漏了 auth()，等于留了一个免票的开放中继。
       */
      if (!auth(req)) return json(res, 401, { error: 'unauthorized' });
      await handleProxy(req, res, url);
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
/*
 * 账本和盘对一遍（用户可能自己清了目录、换了盘、上次写一半断电）。
 * 不 await：启动不该被一次目录扫描拖住。对账跑完之前命不中的那些，
 * 无非是多回一趟上游，等它跑完自然就补上了。
 */
void reconcile().catch((e) => console.warn('[zeno] 缓存对账失败：', e.message));

const token = process.env.SYNC_TOKEN || '';

server.listen(PORT, '0.0.0.0', () => {
  const n = allowedHosts().size;
  console.log('');
  console.log('  Zeno 服务已启动');
  console.log(`  ├─ 本机      http://127.0.0.1:${PORT}`);
  console.log(`  ├─ 局域网    http://<本机IP>:${PORT}`);
  console.log(`  ├─ 静态目录  ${DIST_DIR}`);
  console.log(`  ├─ 数据库    ${process.env.DB_PATH || './data/zeno.db'}`);
  const cdir = cacheDir();
  console.log(
    `  ├─ 图片缓存  ${cdir ? `${cdir}（上限 ${Math.round(cacheMaxBytes() / 1048576)}MB）` : '已关闭'}`,
  );
  console.log(
    `  ├─ 抓取白名单 ${n ? `${n} 个（来自已安装的插件）` : '空 — 装个插件就会自动放行对应站点'}`,
  );
  console.log(`  └─ 同步令牌  ${token ? '已启用' : '未设置（仅靠 tailnet 保护）'}`);
  if (n > 0) {
    console.log('');
    console.log('     已放行：' + [...allowedHosts()].join(', '));
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
