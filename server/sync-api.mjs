import { hostname } from 'node:os';
import { listClients, pull, saveClientState, stats } from './db.mjs';
import { pushAll } from './merge.mjs';
import { removePlugin } from './deletes.mjs';
import { allowedHosts, refreshAllowed } from './allowlist.mjs';
import { renderLoad } from './render.mjs';
import { json, readBody } from './respond.mjs';
import { metricsSnapshot } from './metrics.mjs';

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
    /*
     * 保持原有语义：设了令牌且没带对时，站点列表和 dbPath 都不下发；
     * 没设令牌时 auth() 恒真，这台机器本来只靠 tailnet 保护，health 里的
     * dbPath / allowedHosts 仍然可见（部署脚本靠它检查工作目录和白名单）。
     */
    if (auth(req)) {
      body.allowedHosts = [...allowedHosts()];
    } else {
      delete body.dbPath;
    }
    json(res, 200, body);
    return true;
  }

  /*
   * 运行指标：只给带令牌的人看。里面有路由耗时、内存占用，
   * 公开出去等于把服务端的负载情况告诉 tailnet 里的任何人。
   */
  if (path === '/api/metrics') {
    if (!auth(req)) { json(res, 401, { error: 'unauthorized' }); return true; }
    json(res, 200, { ...metricsSnapshot(), render: renderLoad() });
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
    validateSyncBody(body);
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

/** 单次推送的行数上限。正常多端合并远低于这个数，挡住的是畸形/恶意载荷 */
const MAX_SYNC_ROWS = 20_000;
/** 单个设置值上限。字体、插件数据另有自己的大小（readBody 总共 8MB） */
const MAX_SETTING_BYTES = 256 * 1024;
const MAX_PLUGIN_BYTES = 2 * 1024 * 1024;
const MAX_BOOK_PREFS_BYTES = 512 * 1024;

function bad(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

/**
 * 同步载荷的结构校验。
 *
 * 服务端是最后一道路口：客户端可能有 bug、也可能是别人改过的页面在打这个端点。
 * 这里只做"能不能安全交给 merge"的判断，不重复 merge 的冲突逻辑。
 */
function validateSyncBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('同步体必须是对象');
  if (body.deviceId !== undefined && (typeof body.deviceId !== 'string' || body.deviceId.length > 100)) {
    bad('deviceId 非法');
  }

  for (const key of SYNC_ROWS) {
    const rows = body[key];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) bad(`${key} 必须是数组`);
    if (rows.length > MAX_SYNC_ROWS) bad(`${key} 行数过多`);
    for (const r of rows) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) bad(`${key} 的行必须是对象`);
    }
  }

  for (const r of body.settings ?? []) {
    if (typeof r.key !== 'string' || !r.key || r.key.length > 256) bad('settings.key 非法');
    if (typeof r.value !== 'string' || r.value.length > MAX_SETTING_BYTES) bad('settings.value 非法');
  }

  for (const r of body.plugins ?? []) {
    if (typeof r.id !== 'string' || !r.id || r.id.length > 100) bad('plugins.id 非法');
    if (typeof r.data !== 'string' || !r.data || r.data.length > MAX_PLUGIN_BYTES) bad('plugins.data 非法');
    let plugin;
    try {
      plugin = JSON.parse(r.data);
    } catch {
      bad(`插件 ${r.id} 的 data 不是 JSON`);
    }
    if (!plugin || typeof plugin !== 'object' || plugin.meta?.id !== r.id) {
      bad(`插件 ${r.id} 的 meta.id 与 id 不一致`);
    }
  }

  for (const r of body.bookPrefs ?? []) {
    if (typeof r.data !== 'string' || r.data.length > MAX_BOOK_PREFS_BYTES) bad('bookPrefs.data 非法');
    try {
      JSON.parse(r.data);
    } catch {
      bad('bookPrefs.data 不是 JSON');
    }
  }

  const need = (key, fields) => {
    for (const r of body[key] ?? []) {
      for (const f of fields) {
        if (typeof r[f] !== 'string' || !r[f]) bad(`${key}.${f} 非法`);
      }
    }
  };
  need('shelf', ['pluginId', 'slug']);
  need('positions', ['pluginId', 'slug', 'chapterId']);
  need('lastChapter', ['pluginId', 'slug', 'chapterId']);
  need('bookPrefs', ['pluginId', 'slug']);
  need('bookmarks', ['key', 'pluginId', 'slug', 'chapterId']);
  need('deletes', ['kind', 'id']);
}

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
