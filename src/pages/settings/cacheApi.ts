import { sync } from '@/sync/client';
import { getSyncToken } from '@/sync/device';

/**
 * 服务端图片缓存的配置接口
 *
 * 这些请求打的是**服务端**，不是本机浏览器。所以：
 * - 地址跟着同步配置走（默认同源），令牌也复用同一份；
 * - 配置绝不进 SYNCED_KEYS —— 缓存目录是这台机器的磁盘路径，
 *   同步到手机上只会变成一个谁也打不开的字符串。
 */

export interface CacheStatus {
  /** 空串 = 关掉了 */
  dir: string;
  enabled: boolean;
  maxBytes: number;
  files: number;
  bytes: number;
  /** 所在盘剩余空间；目录还没建出来时拿不到 */
  freeBytes: number | null;
  defaultDir: string;
  /** 写不进去时服务端会说一句话（盘满、权限、目录被删） */
  warning: string | null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const ep = sync.getState().endpoint;
  if (!ep) throw new Error('没有可用的服务端地址');
  const token = getSyncToken();
  const r = await fetch(`${ep}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    // 换目录要在盘上建目录、清空要递归删，给到 15 秒比默认稳
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error || `服务端返回 ${r.status}`);
  return body;
}

export interface DirListing {
  /** null = 这一层是"根列表"（盘符 / 挂载点） */
  path: string | null;
  parent: string | null;
  roots: boolean;
  truncated?: boolean;
  freeBytes: number | null;
  entries: { name: string; path: string }[];
  /** 服务端当前用的目录，界面好知道自己在哪儿 */
  current: string;
}

export const getCacheStatus = () => call<CacheStatus>('/api/cache');

export const browseDirs = (path: string) =>
  call<DirListing>(`/api/cache/dirs?path=${encodeURIComponent(path)}`);

export const saveCacheConfig = (p: { dir?: string; maxMb?: number }) =>
  call<CacheStatus>('/api/cache/config', { method: 'POST', body: JSON.stringify(p) });

export const eraseCache = () =>
  call<CacheStatus>('/api/cache/clear', { method: 'POST', body: '{}' });
