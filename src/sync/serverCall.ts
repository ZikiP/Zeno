import { sync } from '@/sync/client';
import { getSyncToken } from '@/sync/device';

/**
 * 打服务端 API 的公共壳
 *
 * 地址跟着同步配置走（默认同源），令牌复用同一份。
 * 从 cacheApi 里抽出来是因为字体接口要的是同一套鉴权与错误约定 ——
 * 各自写一份，早晚会出现「某个端点忘了带令牌」这种不一致。
 */
export async function serverCall<T>(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  const ep = sync.getState().endpoint;
  if (!ep) throw new Error('没有可用的服务端地址');
  const token = getSyncToken();
  const r = await fetch(`${ep}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    // 换目录要在盘上建目录、扫描要开 zip，给到 15 秒比默认稳
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error || `服务端返回 ${r.status}`);
  return body;
}

/** 同一个壳，但响应是二进制（字体文件） */
export async function serverFetchBinary(path: string, timeoutMs = 60_000): Promise<ArrayBuffer> {
  const ep = sync.getState().endpoint;
  if (!ep) throw new Error('没有可用的服务端地址');
  const token = getSyncToken();
  const r = await fetch(`${ep}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `服务端返回 ${r.status}`);
  }
  return r.arrayBuffer();
}
