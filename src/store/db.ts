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
  settings: {
    key: string;
    value: { key: string; value: unknown };
  };
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
const DB_VER = 2;

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
  // 连带清理该插件的书架与离线缓存
  for (const store of ['shelf', 'chapters'] as const) {
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
