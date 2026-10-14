import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Plugin } from '@/site/types';
import type { ShelfEntry } from './types';

/**
 * 数据库连接与类型定义
 *
 * 只负责「有哪些表、表长什么样」，不关心业务逻辑。
 * 读写在 plugins.ts / shelf.ts / chapters.ts / bookmarks.ts 里。
 */

export interface InstalledPlugin {
  /** 与 plugin.meta.id 相同，作为 IndexedDB 的 keyPath
   *  —— IndexedDB 不支持嵌套 keyPath（plugin.meta.id 会报错） */
  id: string;
  plugin: Plugin;
  installedAt: number;
  updatedAt?: number;
  /** 用户自己创建的 vs 导入的。导入的可能随时失效，UI 上要标出来 */
  origin: 'local' | 'imported';
}

export interface CachedChapter {
  key: string;
  pluginId: string;
  slug: string;
  chapterId: string;
  images: string[];
  cachedAt: number;
  /** 已缓存的字节数估算 */
  bytes: number;
}

export interface CachedChapterList {
  key: string;
  pluginId: string;
  slug: string;
  title: string;
  chapters: { id: string; index: number; title: string }[];
  cachedAt: number;
}

/** 书签 / 笔记。合在一张表，因为都是「定位到某一页」 */
export interface Bookmark {
  key: string;
  pluginId: string;
  slug: string;
  chapterId: string;
  chapterTitle?: string;
  /** 第几张图，从 0 开始 */
  page: number;
  /** 阅读进度百分比，列表展示用 */
  percent: number;
  /** 图片地址，缩略图用。断网时可能加载不出来 */
  thumb?: string;
  createdAt: number;
  /** 有值则是笔记，没有就是纯书签 */
  note?: string;
}

export interface ReaderDB extends DBSchema {
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
    value: CachedChapter;
  };
  /** 书签 / 笔记。合在一张表，因为都是「定位到某一页」 */
  bookmarks: {
    key: string; // `${pluginId}/${slug}/${chapterId}/${page}`
    value: Bookmark;
    indexes: { createdAt: number };
  };
  /** 章节表缓存 —— 避免每次进详情页都重新抓 */
  chapterCache: {
    key: string; // `${pluginId}/${slug}`
    value: CachedChapterList;
  };
  settings: {
    key: string;
    value: { key: string; value: unknown };
  };
}

const DB_NAME = 'zeno-reader';
const DB_VER = 3;

let dbp: Promise<IDBPDatabase<ReaderDB>> | null = null;

export function db(): Promise<IDBPDatabase<ReaderDB>> {
  if (!dbp) {
    dbp = openDB<ReaderDB>(DB_NAME, DB_VER, {
      upgrade(d, old) {
        // v1 用的是 sites 表，v2 改名 plugins，v3 加书签与章节缓存
        // objectStoreNames 在 idb 的类型上只认新表名，转原生类型删旧表
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
        if (!d.objectStoreNames.contains('chapters')) {
          d.createObjectStore('chapters', { keyPath: 'key' });
        }
        if (!d.objectStoreNames.contains('bookmarks')) {
          const s = d.createObjectStore('bookmarks', { keyPath: 'key' });
          s.createIndex('createdAt', 'createdAt');
        }
        if (!d.objectStoreNames.contains('chapterCache')) {
          d.createObjectStore('chapterCache', { keyPath: 'key' });
        }
        if (!d.objectStoreNames.contains('settings')) {
          d.createObjectStore('settings', { keyPath: 'key' });
        }
      },
    });
  }
  return dbp;
}

/** 删掉某个插件名下的全部数据（书架、缓存、书签、章节表） */
export async function deletePluginData(pluginId: string) {
  const d = await db();
  for (const store of ['shelf', 'chapters', 'bookmarks', 'chapterCache'] as const) {
    const keys = (await d.getAllKeys(store)) as string[];
    for (const k of keys) {
      if (typeof k === 'string' && k.startsWith(`${pluginId}/`)) await d.delete(store, k);
    }
  }
}
