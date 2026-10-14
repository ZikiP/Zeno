/**
 * 本地存储：书架 + 阅读进度 + 离线章节缓存
 * 用 IndexedDB（idb 封装），容量比 localStorage 大得多，能存整章图片。
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Comic } from '@/site/twmanga';

interface ReaderDB extends DBSchema {
  /** 书架 */
  shelf: {
    key: string;
    value: ShelfEntry;
    indexes: { addedAt: number };
  };
  /** 离线缓存的章节图片。keyPath 用组合键，保证同一漫画的多个章节各存一条 */
  chapters: {
    key: string; // `${slug}/${chapterId}`
    value: {
      key: string;
      slug: string;
      chapterId: string;
      images: string[];
      cachedAt: number;
      /** 已缓存的字节数估算 */
      bytes: number;
    };
  };
}

export interface ShelfEntry {
  slug: string;
  comic: Comic;
  addedAt: number;
  /** 阅读到的章节 id */
  lastChapterId?: string;
  /** 每章的阅读位置 */
  positions: Record<string, number>;
}

const DB_NAME = 'manga-reader';
const DB_VER = 1;

let dbp: Promise<IDBPDatabase<ReaderDB>> | null = null;

function db() {
  if (!dbp) {
    dbp = openDB<ReaderDB>(DB_NAME, DB_VER, {
      upgrade(d) {
        if (!d.objectStoreNames.contains('shelf')) {
          const s = d.createObjectStore('shelf', { keyPath: 'slug' });
          s.createIndex('addedAt', 'addedAt');
        }
        if (!d.objectStoreNames.contains('chapters')) {
          d.createObjectStore('chapters', { keyPath: 'key' });
        }
      },
    });
  }
  return dbp;
}

/* ── 书架 ─────────────────────────────────────────── */

export async function getShelf(): Promise<ShelfEntry[]> {
  const all = await (await db()).getAll('shelf');
  return all.sort((a, b) => b.addedAt - a.addedAt);
}

export async function isInShelf(slug: string): Promise<boolean> {
  return !!(await (await db()).get('shelf', slug));
}

export async function addToShelf(comic: Comic) {
  await (await db()).put('shelf', {
    slug: comic.slug,
    comic,
    addedAt: Date.now(),
    positions: {},
  });
}

export async function removeFromShelf(slug: string) {
  await (await db()).delete('shelf', slug);
}

export async function savePosition(slug: string, chapterId: string, position: number) {
  const d = await db();
  const entry = await d.get('shelf', slug);
  if (!entry) return;
  await d.put('shelf', {
    ...entry,
    lastChapterId: chapterId,
    positions: { ...entry.positions, [chapterId]: position },
  });
}

/* ── 离线章节缓存 ─────────────────────────────────── */

export async function getCachedChapter(slug: string, chapterId: string) {
  return (await db()).get('chapters', `${slug}/${chapterId}`);
}

export interface CacheProgress {
  done: number;
  total: number;
}

export async function cacheChapterImages(
  slug: string,
  chapterId: string,
  images: string[],
  onProgress?: (p: CacheProgress) => void,
): Promise<number> {
  const d = await db();
  let bytes = 0;
  let done = 0;

  for (const url of images) {
    try {
      // url 在适配层已包过代理，这里直接取
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      bytes += blob.size;
      // 存入 Cache Storage（PWA runtime caching 的兜底，两边都有就断网必可看）
      const cache = await caches.open('comic-images');
      await cache.put(url, new Response(blob, { headers: res.headers }));
    } catch {
      /* 单张失败不中断整章 */
    }
    done++;
    onProgress?.({ done, total: images.length });
  }

  await d.put('chapters', {
    key: `${slug}/${chapterId}`,
    slug,
    chapterId,
    images,
    cachedAt: Date.now(),
    bytes,
  });
  return bytes;
}

export async function listCachedChapters(slug: string) {
  const d = await db();
  const all = await d.getAll('chapters');
  return all
    .filter((c) => c.slug === slug)
    .sort((a, b) => b.cachedAt - a.cachedAt);
}

export async function isChapterCached(slug: string, chapterId: string) {
  return !!(await getCachedChapter(slug, chapterId));
}

/** 删掉某部漫画的全部离线缓存（移除书架时调用） */
export async function deleteCachedBySlug(slug: string) {
  const d = await db();
  const keys = (await d.getAllKeys('chapters')) as string[];
  const toDelete = keys.filter((k) => typeof k === 'string' && k.startsWith(`${slug}/`));
  for (const k of toDelete) await d.delete('chapters', k);
}

/* ── 离线状态 ─────────────────────────────────────── */

export function isOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

export async function estimateStorage() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage: usage ?? 0, quota: quota ?? 0 };
}

/** 格式化成可读文本 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
