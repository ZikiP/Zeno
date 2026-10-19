import { serverCall } from '@/sync/serverCall';

/**
 * 服务端图片缓存的配置接口
 *
 * 这些请求打的是**服务端**，不是本机浏览器。所以：
 * - 地址跟着同步配置走（默认同源），令牌也复用同一份（见 sync/serverCall.ts）；
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

export const getCacheStatus = () => serverCall<CacheStatus>('/api/cache');

export const browseDirs = (path: string) =>
  serverCall<DirListing>(`/api/cache/dirs?path=${encodeURIComponent(path)}`);

export const saveCacheConfig = (p: { dir?: string; maxMb?: number }) =>
  serverCall<CacheStatus>('/api/cache/config', { method: 'POST', body: JSON.stringify(p) });

export const eraseCache = () =>
  serverCall<CacheStatus>('/api/cache/clear', { method: 'POST', body: '{}' });

/** 追漫预热的台账。跟缓存同一栏：管的都是"这台盘上留什么、留多久" */
export interface WarmStatus {
  keep: number;
  concurrency: number;
  /** queued / running / done / dropped / error 各有多少章 */
  states: Record<string, number>;
  /** 还在等的章数（queued + error） */
  pending: number;
  pumping: boolean;
  cache: { files: number; bytes: number };
  cacheMaxBytes: number;
  lastRound: { rows: number; images: number; bytes: number; paused: string | null; at: number } | null;
}

export const getWarmStatus = () => serverCall<WarmStatus>('/api/warm');

/** 一条落盘记录：台账里的一章，配上书架上的书名 */
export interface WarmRecord {
  pluginId: string;
  slug: string;
  title: string;
  chapterId: string;
  /** 站点自己的话数；老递交没带序号时为 null */
  idx: number | null;
  state: 'queued' | 'running' | 'done' | 'error' | 'dropped';
  got: number;
  bytes: number;
  /** 铺完那一刻；没铺完的按台账时间 */
  at: number;
  /** 整本取消追漫 / 移出书架后排上的到期时间 */
  purgeAt: number | null;
  /** 铺了但不全（站点没写页码标记，只认了第 1 页） */
  partial: boolean;
}

export interface WarmLog {
  records: WarmRecord[];
  /** 在册（queued/running/done）的一共多少张、多少字节 */
  warm: { files: number; bytes: number };
}

export const getWarmLog = (limit = 50) =>
  serverCall<WarmLog>(`/api/warm/log?limit=${limit}`);

export const saveWarmKeep = (keep: number) =>
  serverCall<{ keep: number }>('/api/warm/keep', { method: 'POST', body: JSON.stringify({ keep }) });

/** 改完保留章数立刻按新口径扫一遍，不然要等到下一轮（默认 15 分钟）才生效 */
export const sweepWarmNow = () =>
  serverCall<{ dropped: number; files: number; freed: number }>('/api/warm/sweep', {
    method: 'POST',
    body: '{}',
  });
