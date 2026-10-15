/**
 * 这台的设备标识与服务端地址。
 *
 * 从 client.ts 拆出来：同步的"状态机 + 网络"和"我是谁、去哪儿发"是两件事，
 * 前者动得比后者勤，混在一个文件里很快就超了行数上限。
 *
 * 这里的键全部是本机的、不同步：设备内部主键、显示名、服务端地址、令牌。
 * 名字尤其不该同步 —— 那是"这台机器叫什么"，同步过去只会让两台设备同名。
 */

const DEVICE_KEY = 'syncDeviceId';
const LABEL_KEY = 'deviceLabel';
const ENDPOINT_KEY = 'syncEndpoint';
const TOKEN_KEY = 'syncToken';

/**
 * 设备标识。
 * 持久化到 localStorage —— 同一台设备重启后标识不变，
 * 否则服务端会把它当成新设备。用随机串而不是 UA（同型号手机 UA 会撞）。
 */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `dev-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/**
 * 给这台设备起个默认名，只从 UA 猜个大概（机型大类 + 浏览器）。
 *
 * 猜不准没关系 —— 它可以改。但不能空着：列表里全是 dev-xxxx 的时候，
 * 谁也不记得哪台是自己刚买的那台平板。
 */
function guessLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const os = /iPad/.test(ua)
    ? 'iPad'
    : /iPhone/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? '安卓'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : '未知设备';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : '';
  return [os, browser].filter(Boolean).join(' · ');
}

/** 显示名。第一次用就按 UA 生成一个存下来 */
export function getDeviceLabel(): string {
  const saved = localStorage.getItem(LABEL_KEY);
  if (saved !== null && saved !== '') return saved;
  const guess = guessLabel();
  localStorage.setItem(LABEL_KEY, guess);
  return guess;
}

/** 改名。传空 = 回到按 UA 猜的那个，别让列表里出现一台没名字的设备 */
export function setDeviceLabel(value: string): string {
  const next = value.trim() || guessLabel();
  localStorage.setItem(LABEL_KEY, next);
  return next;
}

/**
 * 服务端地址。
 *
 * 默认同源 —— 部署时前后端在同一域名下（/api/sync/*），
 * 用户什么都不用填就能同步。这是绝大多数情况。
 * 只有「前后端分开部署」才需要在设置里显式填地址。
 */
export function getEndpoint(): string {
  const saved = localStorage.getItem(ENDPOINT_KEY);
  if (saved !== null) return saved; // '' 表示用户显式关掉了同步
  return typeof location === 'undefined' ? '' : location.origin;
}

export function getSyncToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setSyncConfig(opts: { endpoint?: string; token?: string }) {
  if (opts.endpoint !== undefined) localStorage.setItem(ENDPOINT_KEY, opts.endpoint);
  if (opts.token !== undefined) {
    if (opts.token) localStorage.setItem(TOKEN_KEY, opts.token);
    else localStorage.removeItem(TOKEN_KEY);
  }
}

/**
 * 设备列表里的一行，来自服务端。
 *
 * role 是服务端判的，不是设备自报的 —— 见 server/sync-api.mjs 的 clientRole。
 */
export interface PeerInfo {
  device_id: string;
  label: string | null;
  role: 'server' | 'client' | null;
  last_push_at: number;
  last_pulled_seq: number;
  user_agent: string | null;
}
