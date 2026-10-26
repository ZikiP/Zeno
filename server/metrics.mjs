/**
 * 极简运行指标
 *
 * 不引 Prometheus：单机单用户的排障只需要知道"哪类请求慢/错、进程吃了多少内存"。
 * 按路由聚合，避免把每个 URL（带 slug、查询串）都存成新键。
 */
const startedAt = Date.now();
const routes = new Map();
let requests = 0;
let errors = 0;

function routeOf(path) {
  if (path.startsWith('/api/sync')) return '/api/sync';
  if (path === '/api/proxy') return '/api/proxy';
  /* 不把任意 /api/xxx 当新键：否则扫路径就能把 Map 撑大 */
  if (path.startsWith('/api/')) return '/api/other';
  return 'static';
}

export function recordRequest(path, status, ms) {
  requests++;
  if (status >= 500) errors++;
  const key = routeOf(path);
  const r = routes.get(key) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
  r.count++;
  if (status >= 500) r.errors++;
  r.totalMs += ms;
  if (ms > r.maxMs) r.maxMs = ms;
  routes.set(key, r);
}

export function metricsSnapshot() {
  const mem = process.memoryUsage();
  return {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    requests,
    errors,
    memoryMB: {
      rss: Math.round(mem.rss / 1048576),
      heapUsed: Math.round(mem.heapUsed / 1048576),
    },
    routes: Object.fromEntries(
      [...routes.entries()].map(([key, r]) => [
        key,
        {
          count: r.count,
          errors: r.errors,
          avgMs: r.count ? Math.round((r.totalMs / r.count) * 10) / 10 : 0,
          maxMs: Math.round(r.maxMs * 10) / 10,
        },
      ]),
    ),
  };
}
