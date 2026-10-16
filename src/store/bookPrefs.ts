import { db } from './db';
import type { BookPrefs } from '@/reader/prefs';

/**
 * 单书显示偏好的读写
 *
 * 存的是 **Partial<BookPrefs>**：没设过的项不落库，读的时候再由全局默认值补。
 * 这样以后给 BookPrefs 加一项，老记录不会缺字段，也不用迁移。
 *
 * `data` 存 JSON 字符串而不是对象，和服务端那一列 TEXT 对齐 ——
 * 少一次结构映射，也免得 IDB 里对象形状跟着类型定义漂移。
 */

export interface BookPrefsRow {
  key: string;
  data: string;
  updatedAt: number;
}

/** 读这本书单独记的那几项。没记过返回 null（调用方用全局默认值） */
export async function getBookPrefs(key: string): Promise<Partial<BookPrefs> | null> {
  const row = (await (await db()).get('bookPrefs', key)) as BookPrefsRow | undefined;
  if (!row?.data) return null;
  try {
    return JSON.parse(row.data) as Partial<BookPrefs>;
  } catch {
    // 坏数据当没记过，而不是让阅读器开不起来
    return null;
  }
}

/**
 * 改这本书的若干项。
 *
 * updatedAt 取"现在"：同步按它做 LWW，别的设备那份更旧就让位、更新就盖过来。
 * 只带显示项进来（pickBook 过滤过），别把亮度这种设备级的写进书里。
 */
export async function saveBookPrefs(key: string, patch: Partial<BookPrefs>): Promise<void> {
  const d = await db();
  const row = (await d.get('bookPrefs', key)) as BookPrefsRow | undefined;
  let merged: Partial<BookPrefs> = {};
  if (row?.data) {
    try {
      merged = JSON.parse(row.data) as Partial<BookPrefs>;
    } catch {
      merged = {};
    }
  }
  const now = Date.now();
  await d.put('bookPrefs', {
    key,
    data: JSON.stringify({ ...merged, ...patch }),
    updatedAt: now,
  });
}

/** 全量导出给同步用 */
export async function listBookPrefs(): Promise<BookPrefsRow[]> {
  return (await (await db()).getAll('bookPrefs')) as BookPrefsRow[];
}

