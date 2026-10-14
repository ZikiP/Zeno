/**
 * 本地存储：内容源插件 + 书架 + 阅读进度 + 离线章节缓存
 *
 * 插件不进代码仓库，只存在使用者自己的浏览器里。
 * 这既是隐私，也意味着：本项目仓库里永远只有通用框架与插件格式说明，
 * 不附带任何现成的内容源。
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Plugin } from '@/site/types';
import { PLUGIN_FORMAT, PLUGIN_TEMPLATE } from '@/site/types';

interface ReaderDB extends DBSchema {
  plugins: {
    /** 顶层 key 是插件 id，方便直接 get/delete */
    key: string;
    value: InstalledPlugin;
    indexes: { installedAt: number };
  };
  /** 书架。keyPath 用组合键，同插件同漫画只存一条 */
  shelf: {
    key: string; // `${pluginId}/${slug}`
    value: ShelfEntry;
    indexes: { addedAt: number };
  };
  /** 离线缓存的章节图片 */
  chapters: {
    key: string; // `${pluginId}/${slug}/${chapterId}`
    value: {
      key: string;
      pluginId: string;
      slug: string;
      chapterId: string;
      images: string[];
      cachedAt: number;
      bytes: number;
    };
  };
  /**
   * 书签与笔记。合在一张表里，因为它们都是「定位到某一页」。
   * 书签只记位置，笔记带文本。
   */
  bookmarks: {
    key: string; // `${pluginId}/${slug}/${chapterId}/${page}`
    value: Bookmark;
    indexes: { createdAt: number };
  };
  /** 章节表缓存 —— 避免每次进详情页都重新抓 */
  chapterCache: {
    key: string; // `${pluginId}/${slug}`
    value: {
      key: string;
      pluginId: string;
      slug: string;
      title: string;
      chapters: { id: string; index: number; title: string }[];
      cachedAt: number;
    };
  };
  settings: {
    key: string;
    value: { key: string; value: unknown };
  };
}

/** 书签 / 笔记 */
export interface Bookmark {
  key: string;
  pluginId: string;
  slug: string;
  chapterId: string;
  chapterTitle?: string;
  /** 第几张图，从 0 开始 */
  page: number;
  /** 阅读进度百分比，用于列表展示 */
  percent: number;
  /** 图片地址，缩略图用。断网时可能加载不出来 */
  thumb?: string;
  createdAt: number;
  /** 有值则是笔记，没有就是纯书签 */
  note?: string;
}

export interface ShelfEntry {
  key: string;
  pluginId: string;
  slug: string;
  title: string;
  cover: string;
  addedAt: number;
  lastChapterId?: string;
  positions: Record<string, number>;
}

/** 插件在本地存储里的附加信息（不污染插件本身，导出时不含这些） */
export interface InstalledPlugin {
  /** 与 plugin.meta.id 相同，作为 IndexedDB 的 keyPath（IndexedDB 不支持嵌套 keyPath） */
  id: string;
  plugin: Plugin;
  installedAt: number;
  updatedAt?: number;
  /** 是否为用户自己创建的 */
  origin: 'local' | 'imported';
}

const DB_NAME = 'zeno-reader';
const DB_VER = 3;

let dbp: Promise<IDBPDatabase<ReaderDB>> | null = null;

function db() {
  if (!dbp) {
    dbp = openDB<ReaderDB>(DB_NAME, DB_VER, {
      upgrade(d, old) {
        // v1 用的是 sites 表（keyPath: 'id'），v2 换成 plugins（同样 keyPath，但 value 包一层）
        // objectStoreNames 在 idb 的类型上只认新表名，这里转成原生类型删旧表
        if (old < 2) {
          const native = d as unknown as IDBDatabase;
          if (native.objectStoreNames.contains('sites')) native.deleteObjectStore('sites');
        }
        if (!d.objectStoreNames.contains('plugins')) {
          const s = d.createObjectStore('plugins', { keyPath: 'id' });
          s.createIndex('installedAt', 'installedAt');
        }
        if (!d.objectStoreNames.contains('shelf')) {
          const s = d.createObjectStore('shelf', { keyPath: 'key' });
          s.createIndex('addedAt', 'addedAt');
        }
        // v3：书签与章节缓存
        if (!d.objectStoreNames.contains('bookmarks')) {
          const s = d.createObjectStore('bookmarks', { keyPath: 'key' });
          s.createIndex('createdAt', 'createdAt');
        }
        if (!d.objectStoreNames.contains('chapterCache')) {
          d.createObjectStore('chapterCache', { keyPath: 'key' });
        }
        if (!d.objectStoreNames.contains('chapters')) d.createObjectStore('chapters', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
      },
    });
  }
  return dbp;
}

/* ── 插件 ─────────────────────────────────────────── */

export async function listPlugins(): Promise<InstalledPlugin[]> {
  const all = await (await db()).getAll('plugins');
  return all.sort((a, b) => a.installedAt - b.installedAt);
}

export async function getPlugin(id: string): Promise<InstalledPlugin | undefined> {
  return (await db()).get('plugins', id);
}

/** 新增或覆盖一个插件。已存在时保留 installedAt，刷新 updatedAt */
export async function savePlugin(item: Omit<InstalledPlugin, 'id' | 'updatedAt'>) {
  const d = await db();
  const id = item.plugin.meta.id;
  const existing = await d.get('plugins', id);
  await d.put('plugins', {
    ...item,
    id,
    installedAt: existing?.installedAt ?? item.installedAt,
    updatedAt: Date.now(),
  });
}

export async function deletePlugin(id: string) {
  const d = await db();
  await d.delete('plugins', id);
  // 连带清理该插件的书架、离线缓存、书签、章节缓存
  for (const store of ['shelf', 'chapters', 'bookmarks', 'chapterCache'] as const) {
    const keys = (await d.getAllKeys(store)) as string[];
    for (const k of keys) if (typeof k === 'string' && k.startsWith(`${id}/`)) await d.delete(store, k);
  }
}

/** 取当前启用的插件；没有就用第一个；一个都没有返回 null（引导用户导入） */
export async function getActivePlugin(): Promise<Plugin | null> {
  const activeId = await getSetting<string>('activePluginId');
  const all = await listPlugins();
  if (all.length === 0) return null;
  if (activeId) {
    const found = all.find((p) => p.plugin.meta.id === activeId);
    if (found) return found.plugin;
  }
  await setSetting('activePluginId', all[0].plugin.meta.id);
  return all[0].plugin;
}

export async function setActivePlugin(id: string) {
  await setSetting('activePluginId', id);
}

/** 新建空白插件 */
export function newPluginTemplate(name: string): Plugin {
  return {
    format: PLUGIN_FORMAT,
    meta: {
      id: `local-${Date.now().toString(36)}`,
      name,
      version: '0.1.0',
    },
    entry: PLUGIN_TEMPLATE.entry,
    urls: { ...PLUGIN_TEMPLATE.urls },
    parse: {
      ...PLUGIN_TEMPLATE.parse,
      title: { attr: 'title' },
    },    headers: {},
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

const shelfKey = (pluginId: string, slug: string) => `${pluginId}/${slug}`;

export async function getShelf(pluginId?: string): Promise<ShelfEntry[]> {
  const all = await (await db()).getAll('shelf');
  const filtered = pluginId ? all.filter((e) => e.pluginId === pluginId) : all;
  return filtered.sort((a, b) => b.addedAt - a.addedAt);
}

export async function isInShelf(pluginId: string, slug: string): Promise<boolean> {
  return !!(await (await db()).get('shelf', shelfKey(pluginId, slug)));
}

export async function addToShelf(
  pluginId: string,
  comic: { slug: string; title: string; cover: string },
) {
  await (await db()).put('shelf', {
    key: shelfKey(pluginId, comic.slug),
    pluginId,
    slug: comic.slug,
    title: comic.title,
    cover: comic.cover,
    addedAt: Date.now(),
    positions: {},
  });
}

export async function removeFromShelf(pluginId: string, slug: string) {
  await (await db()).delete('shelf', shelfKey(pluginId, slug));
}

export async function savePosition(
  pluginId: string,
  slug: string,
  chapterId: string,
  pct: number,
) {
  const d = await db();
  const entry = await d.get('shelf', shelfKey(pluginId, slug));
  if (!entry) return;
  await d.put('shelf', {
    ...entry,
    lastChapterId: chapterId,
    positions: { ...entry.positions, [chapterId]: pct },
  });
}

/* ── 离线缓存 ─────────────────────────────────────── */

const chapKey = (pluginId: string, slug: string, cid: string) => `${pluginId}/${slug}/${cid}`;

export async function getCachedChapter(pluginId: string, slug: string, cid: string) {
  return (await db()).get('chapters', chapKey(pluginId, slug, cid));
}

/**
 * 下载一章的图片到本机离线缓存。
 *
 * 并发控制：默认 3 路并发。
 * 太少（串行）会让几百张图的一章等很久；太多会触发上游 CDN 限流导致失败。
 * 3 是在实测里比较稳的值。
 */
const DOWNLOAD_CONCURRENCY = 3;

/** 单张图的超时。CDN 偶尔会挂住连接，不设超时整章会卡死 */
const IMAGE_TIMEOUT_MS = 30000;

export async function cacheChapterImages(
  pluginId: string,
  slug: string,
  cid: string,
  images: string[],
  onProgress?: (p: { done: number; total: number }) => void,
): Promise<number> {
  const d = await db();
  let bytes = 0;
  let done = 0;

  const cache = await caches.open('comic-images');

  async function downloadOne(url: string) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      await cache.put(url, new Response(blob, { headers: res.headers }));
      return blob.size;
    } catch {
      return 0; // 单张失败不中断整章
    } finally {
      clearTimeout(timer);
      done++;
      onProgress?.({ done, total: images.length });
    }
  }

  // 定长工作池：始终保持 N 个任务在跑
  let cursor = 0;
  const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, images.length) }, async () => {
    while (cursor < images.length) {
      const i = cursor++;
      bytes += await downloadOne(images[i]);
    }
  });
  await Promise.all(workers);

  await d.put('chapters', {
    key: chapKey(pluginId, slug, cid),
    pluginId,
    slug,
    chapterId: cid,
    images,
    cachedAt: Date.now(),
    bytes,
  });
  return bytes;
}

export async function listCachedChapters(pluginId: string, slug: string) {
  const all = await (await db()).getAll('chapters');
  return all
    .filter((c) => c.pluginId === pluginId && c.slug === slug)
    .sort((a, b) => b.cachedAt - a.cachedAt);
}

export async function deleteCachedByPluginAndSlug(pluginId: string, slug: string) {
  const d = await db();
  const keys = (await d.getAllKeys('chapters')) as string[];
  for (const k of keys) {
    if (typeof k === 'string' && k.startsWith(`${pluginId}/${slug}/`)) await d.delete('chapters', k);
  }
}

/* ── 章节表缓存 ───────────────────────────────────── */

/**
 * 缓存漫画的章节表。
 * 阅读器内的章节列表要用它 —— 否则打开阅读器还得重新抓一次详情页。
 */
export async function cacheChapterList(
  pluginId: string,
  slug: string,
  title: string,
  chapters: { id: string; index: number; title: string }[],
) {
  await (await db()).put('chapterCache', {
    key: `${pluginId}/${slug}`,
    pluginId,
    slug,
    title,
    chapters,
    cachedAt: Date.now(),
  });
}

export async function getChapterList(pluginId: string, slug: string) {
  return (await db()).get('chapterCache', `${pluginId}/${slug}`);
}

/* ── 书签 / 笔记 ──────────────────────────────────── */

const bmKey = (pluginId: string, slug: string, cid: string, page: number) =>
  `${pluginId}/${slug}/${cid}/${page}`;

export async function addBookmark(b: Omit<Bookmark, 'key' | 'createdAt'> & { key?: string }) {
  const key = b.key ?? bmKey(b.pluginId, b.slug, b.chapterId, b.page);
  const existing = await (await db()).get('bookmarks', key);
  await (await db()).put('bookmarks', {
    ...b,
    key,
    createdAt: existing?.createdAt ?? Date.now(),
  });
  return key;
}

export async function updateBookmarkNote(key: string, note: string) {
  const d = await db();
  const bm = await d.get('bookmarks', key);
  if (!bm) return;
  await d.put('bookmarks', { ...bm, note });
}

export async function removeBookmark(key: string) {
  await (await db()).delete('bookmarks', key);
}

export async function getBookmarks(pluginId: string, slug?: string): Promise<Bookmark[]> {
  const all = await (await db()).getAll('bookmarks');
  const filtered = slug ? all.filter((b) => b.pluginId === pluginId && b.slug === slug) : all;
  return filtered.sort((a, b) => b.createdAt - a.createdAt);
}

/** 某章已有书签的页码集合，用于在阅读器里标记 */
export async function getBookmarkedPages(
  pluginId: string,
  slug: string,
  chapterId: string,
): Promise<Set<number>> {
  const all = await (await db()).getAll('bookmarks');
  return new Set(
    all
      .filter((b) => b.pluginId === pluginId && b.slug === slug && b.chapterId === chapterId)
      .map((b) => b.page),
  );
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
