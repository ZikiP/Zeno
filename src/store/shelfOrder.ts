/**
 * 书架的**顺序**与显示偏好
 *
 * 和 shelf.ts 的分工：那边是「这本书在不在架上、读到哪了」的存储，
 * 这边是「架子怎么摆」—— 手动顺序、排序方式、大小屏格子数。
 * 拆开的理由很实际：合在一起过了 300 行上限，而且两件事的改动原因完全不同
 * （加一个存储字段 vs 加一种排法）。
 *
 * 两种持久化方式别混：
 *   - 手动顺序是**可同步的数据**，存在每条书架记录的 order 上（跟着 LWW 走）；
 *   - 排法与格子数是**同步的偏好**，写在 localStorage 并带 __at 时间戳
 *     （键名见 sync/transfer.ts 的 SYNCED_KEYS）。
 */
import { db } from './db';
import { setLocalPref } from '@/sync/localPrefs';
import { serverNow } from '@/sync/clock';
import type { ShelfEntry } from './types';

/* ── 排序方式 ─────────────────────────────────────── */

/** custom = 用户手拽出来的顺序 */
export type ShelfSort = 'custom' | 'added' | 'read' | 'progress';

export const SHELF_SORTS: { key: ShelfSort; label: string; hint: string }[] = [
  { key: 'custom', label: '自定义顺序', hint: '长按卡片拖动摆放' },
  { key: 'added', label: '最近添加', hint: '新入架的排在最前' },
  { key: 'read', label: '最近阅读', hint: '按上一次翻开的时间' },
  { key: 'progress', label: '全书进度', hint: '看完的排最后，没开始的排最前' },
];

const SORT_KEY = 'shelfSort';

/** 排序方式是同步的本地偏好：换设备打开书架，排法应该跟着走 */
export function getShelfSort(): ShelfSort {
  const v = localStorage.getItem(SORT_KEY);
  return SHELF_SORTS.some((s) => s.key === v) ? (v as ShelfSort) : 'custom';
}

export function setShelfSort(mode: ShelfSort): void {
  setLocalPref(SORT_KEY, mode);
}

/**
 * 按界面要的排序方式排。
 *
 * progressOf 由调用方给：全书进度要用章节表缓存算，那是页面已经拿到的数据，
 * 存储层不该为了排序再去捞一遍缓存。
 */
export function sortShelf(
  entries: ShelfEntry[],
  mode: ShelfSort,
  progressOf: (e: ShelfEntry) => number = () => 0,
): ShelfEntry[] {
  const byAdded = (a: ShelfEntry, b: ShelfEntry) => b.addedAt - a.addedAt;
  const out = [...entries];

  if (mode === 'added') return out.sort(byAdded);
  if (mode === 'read') {
    return out.sort((a, b) => (b.lastChapterAt ?? 0) - (a.lastChapterAt ?? 0) || byAdded(a, b));
  }
  if (mode === 'progress') {
    return out.sort((a, b) => progressOf(b) - progressOf(a) || byAdded(a, b));
  }

  /*
   * 自定义：没排过序的（order 是 undefined）一律排在已排好的后面。
   * 让它们参与减法会得出 NaN —— 比较函数返回 NaN 时浏览器不报错，
   * 只是顺序变得无法解释，表现就是"每次刷新书架都在换位置"。
   */
  return out.sort((a, b) => {
    if (a.order === undefined && b.order === undefined) return byAdded(a, b);
    if (a.order === undefined) return 1;
    if (b.order === undefined) return -1;
    return a.order - b.order || byAdded(a, b);
  });
}

/**
 * 写下手动顺序。入参是**界面上从上到下的 key 顺序**。
 *
 * 只改真正动了的那几行：位置没变的行连 updatedAt 都不顶。
 * 一次拖拽就把整架记录标成"刚刚更新"，等于让这台设备在 LWW 里
 * 赢下所有行 —— 另一台设备上更新的标题会被这里的旧值盖掉。
 */
export async function setShelfOrder(orderedKeys: string[]): Promise<number> {
  const d = await db();
  const t = d.transaction('shelf', 'readwrite');
  const store = t.objectStore('shelf');
  const now = serverNow();
  let moved = 0;

  for (let i = 0; i < orderedKeys.length; i++) {
    const entry = (await store.get(orderedKeys[i])) as ShelfEntry | undefined;
    if (!entry || entry.order === i) continue;
    await store.put({ ...entry, order: i, updatedAt: now });
    moved++;
  }
  await t.done;
  return moved;
}

/* ── 格子数 ───────────────────────────────────────── */

/**
 * 大小屏各一个列数。
 *
 * 为什么是"两个数"而不是"一个数"：手机和 27 寸显示器共用一个列数必然有一边难看 ——
 * 手机上 4 列封面只有 80px 宽，显示器上 3 列则铺满整屏全是空白。
 * 两个值一起同步，每台设备按自己的视口取用，于是"我把它设成 3 列"这件事
 * 不用每台设备重说一遍。
 */
export const SHELF_COLS = {
  sm: { min: 2, max: 6, def: 3 },
  lg: { min: 2, max: 12, def: 4 },
} as const;

/** 大屏的判定线，和 browse.css 里那条媒体查询必须一致 */
export const SHELF_COLS_BREAKPOINT = 700;

const COLS_SM = 'shelfColsSm';
const COLS_LG = 'shelfColsLg';

const readCols = (key: string, { min, max, def }: { min: number; max: number; def: number }) => {
  /* 先判 null 再转数：Number(null) 是 0，会被下面的夹取当成"合法的 2 列"，
     于是从没设过格子数的设备一律落在下限上，默认值根本用不上。 */
  const raw = localStorage.getItem(key);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
};

export function getShelfCols(): { sm: number; lg: number } {
  return { sm: readCols(COLS_SM, SHELF_COLS.sm), lg: readCols(COLS_LG, SHELF_COLS.lg) };
}

export function setShelfCols(sm: number, lg: number): void {
  setLocalPref(COLS_SM, String(Math.min(SHELF_COLS.sm.max, Math.max(SHELF_COLS.sm.min, sm))));
  setLocalPref(COLS_LG, String(Math.min(SHELF_COLS.lg.max, Math.max(SHELF_COLS.lg.min, lg))));
}
