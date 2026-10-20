/**
 * 抓取代理的目标地址策略（SSRF 防护）
 *
 * 代理会替请求方去访问任意 URL，白名单只挡域名、不挡"这个域名解析到哪"。
 * 装一个 entry 指向 127.0.0.1 或 169.254.169.254 的插件，就能让服务端自己去
 * 够内网和云元数据接口。这里把这类地址一律拒掉。
 *
 * 局限（要说清楚，别当成已经闭环）：
 * 这里是"先解析校验、再发请求"，两次解析之间域名可以换记录（DNS rebinding）。
 * 彻底闭环要在建连时再校验一次 IP —— Node 的全局 fetch 不暴露那个钩子。
 * 本工具的威胁模型是"别人分享给你的插件文件"，不是能控制你 DNS 的定向攻击；
 * 按这个尺度，请求时校验是合适的强度。要接真正的对抗性威胁模型，得换
 * 带自定义 lookup 的 connector。
 */
import { lookup } from 'node:dns/promises';

const V4_BLOCKED = [
  ['0.0.0.0', 8], // 本网络
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT —— Tailscale 的地址段，含服务自己
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地 + 云厂商元数据
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // 基准测试
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留
];

/** 点分四段 → 32 位整数；不是合法 IPv4 字面量则返回 null */
function v4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inV4Cidr(ip, [cidr, bits]) {
  const a = v4ToInt(ip);
  const b = v4ToInt(cidr);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a >>> 0 & mask) === (b & mask);
}

export function isBlockedV4(ip) {
  return V4_BLOCKED.some((c) => inV4Cidr(ip, c));
}

/** IPv6 → 8 个 16 位段；非法返回 null。支持 `::` 压缩和末尾点分四段 */
function parseV6(input) {
  let s = String(input).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const n = v4ToInt(tail[2]);
    if (n === null) return null;
    s = `${tail[1]}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/** 从 IPv6 里还原被嵌进去的 IPv4（mapped / NAT64 / 6to4 / Teredo） */
function embeddedV4(g) {
  const quad = (a, b) => `${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`;
  if (!g) return null;
  // ::ffff:a.b.c.d（IPv4-mapped）
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return quad(g[6], g[7]);
  }
  // ::a.b.c.d（已废弃的 IPv4-compatible，但仍有系统按 v4 连）
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    if (g[6] === 0 && g[7] <= 1) return null; // :: 和 ::1 单独处理
    return quad(g[6], g[7]);
  }
  // 64:ff9b::/96（NAT64）
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return quad(g[6], g[7]);
  }
  // 2002::/16（6to4）：紧跟在 2002 后面的 32 位就是 IPv4
  if (g[0] === 0x2002) return quad(g[1], g[2]);
  // 2001:0::/32（Teredo）：最后 32 位取反
  if (g[0] === 0x2001 && g[1] === 0) {
    return quad((~g[6]) & 0xffff, (~g[7]) & 0xffff);
  }
  return null;
}

function blockedV6(g, hardOnly) {
  if (!g) return false;
  if (g.every((x) => x === 0)) return true; // ::
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) {
    return true; // ::1
  }
  if (g[0] >= 0xfc00 && g[0] <= 0xfdff) return true; // ULA
  if (g[0] >= 0xfe80 && g[0] <= 0xfebf) return true; // 链路本地
  if (g[0] >= 0xfec0 && g[0] <= 0xfeff) return true; // 旧 site-local
  if (g[0] >= 0xff00) return true; // 组播
  const v4 = embeddedV4(g);
  if (v4) return hardOnly ? isHardBlockedIp(v4) : isBlockedV4(v4);
  return false;
}

export function isBlockedV6(ip) {
  return blockedV6(parseV6(ip), false);
}

export function isBlockedIp(ip) {
  return ip.includes(':') ? isBlockedV6(ip) : isBlockedV4(ip);
}

/** 一眼就该拒掉的主机名，不必再去解析 */
export function isBlockedHostname(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h.includes('.')) return true; // 单标签名，走的是本地解析
  if (/\.(local|internal|localhost|localdomain|home|lan|corp)$/.test(h)) return true;
  if (h === 'metadata.google.internal' || h.startsWith('metadata.')) return true;
  return false;
}

/**
 * 校验目标地址。返回 { ok: true } 或 { ok: false, reason }。
 *
 * 分两档，因为开着透明代理（Clash / FlClash 的 TUN + fake-ip）时，
 * 系统 DNS **和公网 DNS 服务器**都会被接管 —— 实测向 223.5.5.5 查
 * example.com 也返回 172.29.0.146。也就是说在这种机器上，
 * "域名解析到 RFC1918 段"是常态而不是攻击迹象，拿它当判据会把抓取全部打死。
 *
 *   字面量档：主机名直接写 IP 时没有"被污染的解析结果"这回事，按全量策略拒
 *            （回环 / RFC1918 / 链路本地 / CGNAT / 0-8 / 组播 / 保留）。
 *   域名档：  只拒硬档 —— 回环、链路本地（含 169.254.169.254 云元数据）、
 *            CGNAT/Tailscale、0/8、组播、保留，以及无点主机名和 .internal 之类。
 *
 * 已知缺口（如实写在这里，别假装闭环了）：
 *   1. 域名解析到 RFC1918（比如内网 DNS 下一条指向 10.0.0.5 的记录）不拒。
 *      在透明代理环境下无法与 fake-ip 区分。
 *   2. DNS rebinding：先给公网答案过校验、再给内网答案建连。
 *      彻底闭环要在建连时再校验一次目的 IP，Node 全局 fetch 不暴露那个钩子。
 *
 * 按本工具的威胁模型 —— 风险来自"别人分享给你的插件 JSON"，里面写个
 * entry: http://127.0.0.1 或 http://169.254.169.254 —— 上面这两条缺口
 * 都不是同一种攻击；要接对抗性威胁模型得换成带自定义 lookup 的 connector。
 */
export async function assertPublicTarget(parsed, { allowPrivate = false } = {}) {
  if (allowPrivate) return { ok: true };

  const proto = parsed.protocol;
  if (proto !== 'http:' && proto !== 'https:') {
    return { ok: false, reason: `不支持的协议 ${proto}` };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isBlockedHostname(host)) return { ok: false, reason: `本地/内网主机名 ${host}` };

  const isIpLiteral = v4ToInt(host) !== null || host.includes(':');
  if (isIpLiteral) {
    if (isBlockedIp(host)) return { ok: false, reason: `${host} 是被拒地址字面量` };
    return { ok: true };
  }

  let recs;
  try {
    recs = await lookup(host, { all: true, verbatim: true });
  } catch (e) {
    return { ok: false, reason: `解析失败：${e.code ?? e.message}` };
  }
  if (!recs.length) return { ok: false, reason: `${host} 无解析结果` };

  for (const r of recs) {
    if (isHardBlockedIp(r.address)) {
      return { ok: false, reason: `${host} 解析到 ${r.address}（回环/链路本地/Tailscale 段）` };
    }
  }
  return { ok: true };
}

/** 回环 / 链路本地+云元数据 / CGNAT+Tailscale / 0/8 / 组播 / 保留 —— 不含 RFC1918 */
export function isHardBlockedIp(ip) {
  if (ip.includes(':')) return blockedV6(parseV6(ip), true);
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((x) => !Number.isFinite(x))) return false;
  if (o[0] === 0 || o[0] === 127 || o[0] === 169) return true;
  if (o[0] >= 224) return true; // 组播 + 保留
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT，含 Tailscale
  return false;
}
