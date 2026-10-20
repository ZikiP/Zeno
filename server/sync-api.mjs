import { hostname } from 'node:os';
import { listClients, pull, saveClientState, stats } from './db.mjs';
import { pushAll } from './merge.mjs';
import { removePlugin } from './deletes.mjs';
import { allowedHosts, refreshAllowed } from './allowlist.mjs';
import { renderLoad } from './render.mjs';
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
    const body = { ok: true, version: 1, ...stats(), render: renderLoad(), allowedHostsCount: allowedHosts().size };
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
    saveClientState(deviceId, data.seq, ua(req), clientLabel(req), clientRole(req));
    /*
     * serverTime 是给客户端对时用的：冲突解决比的是 updatedAt 谁大，
     * 而那原本是各设备自己的挂钟（见 src/sync/clock.ts）。
     */
    json(res, 200, { ...data, serverTime: Date.now() });
    return true;
  }

  if (path === '/api/sync/push' && req.method === 'POST') {
    if (!auth(req)) { json(res, 401, { error: 'unauthorized' }); return true; }
    const body = await readBody(req);
    const deviceId = body.deviceId ?? req.headers['x-device-id'] ?? 'unknown';
    dropFutureRows(body);
    const result = pushAll(body, deviceId);
    saveClientState(deviceId, body.seq ?? 0, ua(req), clientLabel(req), clientRole(req));

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
      serverTime: Date.now(),
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

/** 客户端时钟比服务端快出这么多，就认为它坏了 */
const FUTURE_SKEW_MS = 10 * 60_000;
/** 同步推送里所有带 updatedAt / deletedAt 的数组 */
const SYNC_ROWS = [
  'plugins',
  'shelf',
  'positions',
  'lastChapter',
  'bookmarks',
  'bookPrefs',
  'settings',
  'deletes',
];

/**
 * 丢掉时间戳来自"未来"的同步行。
 *
 * LWW 比的是 updatedAt。一台时钟快出几天的设备（或写了 Date.now()+1e9 的脚本）
 * 会让它之后每一条修改都永远压住别的设备，而且自己还一直赢 —— 一条坏记录
 * 就能把某个键钉死到那个未来时刻。超过 10 分钟的未来一律视为坏时钟，不落库；
 * 客户端下一次拉取会拿到正常时间戳，本地那个未来值也会被掰回来
 * （见 src/sync/applyRemote.ts 的同一条判据）。
 */
function dropFutureRows(body) {
  const horizon = Date.now() + FUTURE_SKEW_MS;
  const dropped = [];
  for (const key of SYNC_ROWS) {
    const rows = body[key];
    if (!Array.isArray(rows)) continue;
    body[key] = rows.filter((row) => {
      const ts = Number(row?.updatedAt ?? row?.deletedAt ?? 0);
      if (!Number.isFinite(ts) || ts <= horizon) return true;
      dropped.push(`${key}:${row?.key ?? row?.id ?? row?.chapterId ?? '?'}`);
      return false;
    });
  }
  if (dropped.length) {
    console.warn(
      `[zeno] 丢弃 ${dropped.length} 条未来时间戳的同步行：${dropped.slice(0, 5).join(', ')}`,
    );
  }
}

/** 设备表里记的 UA 只是排查用，截断即可，别把整条存进库 */
function ua(req) {
  return req.headers['user-agent']?.slice(0, 200) ?? null;
}

/**
 * 这台设备是「跑服务的那台机器」还是「别的客户端」。
 *
 * 判据只有两条，两条都对不上就老实说客户端 —— 标错角色比不标更误导人。
 *   1. 连接本身来自回环地址：在那台机器上开浏览器访问 localhost:8788；
 *   2. 浏览器上报的 hostname 就是服务端自己的主机名（含 MiniPC 上
 *      用 http://minipc:8788 这种本机名，或 magicDNS 的 minipc.xxx.ts.net
 *      —— 第一段就等于 os.hostname()）。
 *
 * 注意这跟"哪个浏览器在用"无关，说的是**物理机器**：手机、平板都是客户端，
 * 哪怕它们是同一个人手上那几台。
 */
function clientRole(req) {
  const peer = req.socket.remoteAddress ?? '';
  if (peer === '127.0.0.1' || peer === '::1' || peer.startsWith('::ffff:127.')) return 'server';
  const host = String(req.headers['x-client-host'] ?? '').toLowerCase().trim();
  const self = (hostname() || '').toLowerCase();
  if (host && self && (host === self || host.startsWith(`${self}.`))) return 'server';
  return 'client';
}

/** 设备显示名。客户端编码过（头的值只能是 latin1），中文名字得解码回来 */
function clientLabel(req) {
  const raw = req.headers['x-device-label'];
  if (!raw) return null;
  try {
    return decodeURIComponent(String(raw)).slice(0, 60) || null;
  } catch {
    // 半截的百分号转义：宁可不改名，也别让一次同步 500
    return null;
  }
}
