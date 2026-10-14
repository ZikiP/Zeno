/**
 * 本地存储：站点配置 + 书架 + 阅读进度 + 离线章节缓存
 *
 * 站点信息不进代码仓库，只存在使用者自己的浏览器里。
 * 这既是隐私，也意味着：本项目仓库里永远只有通用框架，
 * 没有任何人填的具体站点地址与解析规则。
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { SiteConfig } from '@/site/types';
import { SITE_TEMPLATE } from '@/site/types';

interface ReaderDB extends DBSchema {
  sites: {
    key: string;
    value: SiteConfig;
  };
  /** 书架。keyPath 用组合键，同站同漫画只存一条 */
  shelf: {
    key: string; // `${siteId}/${slug}`
    value: ShelfEntry;
    indexes: { addedAt: number };
  };
  /** 离线缓存的章节图片 */
  chapters: {
    key: string; // `${siteId}/${slug}/${chapterId}`
    value: {
      key: string;
      siteId: string;
      slug: string;
      chapterId: string;
      images: string[];
      cachedAt: number;
      bytes: number;
    };
  };
  settings: {
    key: string;
    value: { key: string; value: unknown };
  };
}

export interface ShelfEntry {
  key: string;
  siteId: string;
  slug: string;
  title: string;
  cover: string;
  addedAt: number;
  lastChapterId?: string;
  positions: Record<string, number>;
}

const DB_NAME = 'zeno-reader';
const DB_VER = 1;

let dbp: Promise<IDBPDatabase<ReaderDB>> | null = null;

function db() {
  if (!dbp) {
    dbp = openDB<ReaderDB>(DB_NAME, DB_VER, {
      upgrade(d) {
        if (!d.objectStoreNames.contains('sites')) d.createObjectStore('sites', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('shelf')) {
          const s = d.createObjectStore('shelf', { keyPath: 'key' });
          s.createIndex('addedAt', 'addedAt');
        }
        if (!d.objectStoreNames.contains('chapters')) d.createObjectStore('chapters', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
      },
    });
  }
  return dbp;
}

/* ── 站点 ─────────────────────────────────────────── */

export async function listSites(): Promise<SiteConfig[]> {
  return (await db()).getAll('sites');
}

export async function getSite(id: string): Promise<SiteConfig | undefined> {
  return (await db()).get('sites', id);
}

export async function saveSite(site: SiteConfig) {
  await (await db()).put('sites', site);
}

export async function deleteSite(id: string) {
  const d = await db();
  await d.delete('sites', id);
  // 连带清理该站的书架与离线缓存
  for (const store of ['shelf', 'chapters'] as const) {
    const keys = (await d.getAllKeys(store)) as string[];
    for (const k of keys) if (typeof k === 'string' && k.startsWith(`${id}/`)) await d.delete(store, k);
  }
}

/** 取当前站点；没有就用第一个；一个都没有返回 null（引导用户新建） */
export async function getActiveSite(): Promise<SiteConfig | null> {
  const activeId = await getSetting<string>('activeSiteId');
  const all = await listSites();
  if (all.length === 0) return null;
  if (activeId) {
    const found = all.find((s) => s.id === activeId);
    if (found) return found;
  }
  await setSetting('activeSiteId', all[0].id);
  return all[0];
}

export async function setActiveSite(id: string) {
  await setSetting('activeSiteId', id);
}

export function newSiteTemplate(name: string): SiteConfig {
  return {
    ...SITE_TEMPLATE,
    id: `site-${Date.now().toString(36)}`,
    name,
    urls: { ...SITE_TEMPLATE.urls },
    parse: {
      ...SITE_TEMPLATE.parse,
      title: { attr: 'title' },
    },
    headers: {},
    imageHosts: [],
  };
}

/* ── 通用设置 ─────────────────────────────────────── */

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const row = await (await db()).get('settings', key);
  return row?.value as T | undefined;
}

export async function setSetting(key: string, value: unknown) {
  await (await db()).put('settings', { key, value });
}

/* ── 书架 ─────────────────────────────────────────── */

const shelfKey = (siteId: string, slug: string) => `${siteId}/${slug}`;

export async function getShelf(siteId?: string): Promise<ShelfEntry[]> {
  const all = await (await db()).getAll('shelf');
  const filtered = siteId ? all.filter((e) => e.siteId === siteId) : all;
  return filtered.sort((a, b) => b.addedAt - a.addedAt);
}

export async function isInShelf(siteId: string, slug: string): Promise<boolean> {
  return !!(await (await db()).get('shelf', shelfKey(siteId, slug)));
}

export async function addToShelf(
  siteId: string,
  comic: { slug: string; title: string; cover: string },
) {
  await (await db()).put('shelf', {
    key: shelfKey(siteId, comic.slug),
    siteId,
    slug: comic.slug,
    title: comic.title,
    cover: comic.cover,
    addedAt: Date.now(),
    positions: {},
  });
}

export async function removeFromShelf(siteId: string, slug: string) {
  await (await db()).delete('shelf', shelfKey(siteId, slug));
}

export async function savePosition(
  siteId: string,
  slug: string,
  chapterId: string,
  pct: number,
) {
  const d = await db();
  const entry = await d.get('shelf', shelfKey(siteId, slug));
  if (!entry) return;
  await d.put('shelf', {
    ...entry,
    lastChapterId: chapterId,
    positions: { ...entry.positions, [chapterId]: pct },
  });
}

/* ── 离线缓存 ─────────────────────────────────────── */

const chapKey = (siteId: string, slug: string, cid: string) => `${siteId}/${slug}/${cid}`;

export async function getCachedChapter(siteId: string, slug: string, cid: string) {
  return (await db()).get('chapters', chapKey(siteId, slug, cid));
}

export async function cacheChapterImages(
  siteId: string,
  slug: string,
  cid: string,
  images: string[],
  onProgress?: (p: { done: number; total: number }) => void,
): Promise<number> {
  const d = await db();
  let bytes = 0;
  let done = 0;

  for (const url of images) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      bytes += blob.size;
      const cache = await caches.open('comic-images');
      await cache.put(url, new Response(blob, { headers: res.headers }));
    } catch {
      /* 单张失败不中断整章 */
    }
    done++;
    onProgress?.({ done, total: images.length });
  }

  await d.put('chapters', {
    key: chapKey(siteId, slug, cid),
    siteId,
    slug,
    chapterId: cid,
    images,
    cachedAt: Date.now(),
    bytes,
  });
  return bytes;
}

export async function listCachedChapters(siteId: string, slug: string) {
  const all = await (await db()).getAll('chapters');
  return all
    .filter((c) => c.siteId === siteId && c.slug === slug)
    .sort((a, b) => b.cachedAt - a.cachedAt);
}

export async function deleteCachedBySiteAndSlug(siteId: string, slug: string) {
  const d = await db();
  const keys = (await d.getAllKeys('chapters')) as string[];
  for (const k of keys) {
    if (typeof k === 'string' && k.startsWith(`${siteId}/${slug}/`)) await d.delete('chapters', k);
  }
}

/* ── 工具 ─────────────────────────────────────────── */

export function isOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
