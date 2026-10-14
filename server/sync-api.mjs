import { listClients, pull, saveClientState, stats } from './db.mjs';
import { pushAll } from './merge.mjs';
import { removePlugin } from './deletes.mjs';
import { allowedHosts, refreshAllowed } from './allowlist.mjs';
import { json, readBody } from './respond.mjs';

/**
 * 同步与状态 API
 *
 * 从 index.mjs 抽出来：那五个端点是同一件事（多端数据收敛），
 * 而 index.mjs 该剩下的只有「这个请求归谁」。
 *
 * @returns {Promise<boolean>} 已经处理完了（true 时调用方不要再往下走）
 */
export async function handleSyncApi(req, res, url, auth) {
  const path = url.pathname;

  if (path === '/api/health') {
    /*
     * 公开字段只到"活着没有"。dbPath 是绝对路径、allowedHosts 等于
     * 在告诉任何能连上这个端口的人"你在读哪些站点" —— 这两个只在带令牌时给。
     * 计数保留公开，部署脚本的健康检查要用，而且本身不敏感。
     */
    const body = { ok: true, version: 1, ...stats(), allowedHostsCount: allowedHosts().size };
    if (auth(req)) {
      body.allowedHosts = [...allowedHosts()];
    } else {
      delete body.dbPath;
    }
    json(res, 200, body);
    return true;
  }

  if (path === '/api/sync/clients') {
    if (!auth(req)) { json(res, 401, { error: 'unauthorized' }); return true; }
    json(res, 200, { clients: listClients() });
    return true;
  }

  if (path === '/api/sync/pull' && req.method === 'GET') {
    if (!auth(req)) { json(res, 401, { error: 'unauthorized' }); return true; }
    const since = Number(url.searchParams.get('since') ?? 0);
    const deviceId = url.searchParams.get('deviceId') ?? 'unknown';
    const data = pull(Number.isFinite(since) ? since : 0);
    saveClientState(deviceId, data.seq, ua(req));
    json(res, 200, data);
    return true;
  }

  if (path === '/api/sync/push' && req.method === 'POST') {
    if (!auth(req)) { json(res, 401, { error: 'unauthorized' }); return true; }
    const body = await readBody(req);
    const deviceId = body.deviceId ?? req.headers['x-device-id'] ?? 'unknown';
    const result = pushAll(body, deviceId);
    saveClientState(deviceId, body.seq ?? 0, ua(req));

    /*
     * 插件变了，白名单跟着变。
     * 不刷新的话，用户在手机上装好插件后，家里 MiniPC 的代理还是拒绝该站点，
     * 表现是「明明装了插件还是抓不到」—— 很难自己想到跟白名单有关。
     */
    refreshAllowed();

    json(res, 200, {
      ok: true,
      applied: result,
      serverSeq: stats().seq,
      allowedHosts: [...allowedHosts()],
    });
    return true;
  }

  /* 删除插件。走独立端点而不是等下一轮全量推送，删完要立刻生效 */
  if (path === '/api/sync/forget-plugin' && req.method === 'POST') {
    if (!auth(req)) { json(res, 401, { error: 'unauthorized' }); return true; }
    const body = await readBody(req);
    const id = String(body.id ?? '');
    if (!id) { json(res, 400, { error: 'missing id' }); return true; }

    const removed = removePlugin(id, body.deviceId ?? 'unknown');
    refreshAllowed();
    json(res, 200, { ok: true, removed, allowedHosts: [...allowedHosts()] });
    return true;
  }

  return false;
}

/** 设备表里记的 UA 只是排查用，截断即可，别把整条存进库 */
function ua(req) {
  return req.headers['user-agent']?.slice(0, 200) ?? null;
}
