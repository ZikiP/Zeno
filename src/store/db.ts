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
  /**
   * 图片是不是真的搬到设备上了。
   *
   * 这个区分是必须的：翻开一章就该立刻把**地址表**存下来（重进这一章不用再
   * 跑一次服务端渲染），但整章几十张图（实测一章 6–18 MB）不该在你只是读它
   * 的时候被后台偷偷下完 —— 那是详情页那颗「离线下载」的职责。
   *
   * undefined 当 true 处理：老数据只可能由整章下载写出来。
   */
  downloaded?: boolean;
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
  /**
   * 内容（笔记 / 缩略图）最近一次修改时间。
   * 同步的 LWW 比的是它 —— 之前推上去的是 createdAt，
   * 于是改了笔记也永远"不比服务端新"，编辑同步不过去。
   */
  updatedAt?: number;
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
    indexes: { addedAt: number; pluginId: string };
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
    indexes: { createdAt: number; pluginId: string };
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
  /**
   * 每本书自己的显示偏好（图片适配、方向、单双页、底色、灰度）。
   *
   * 单独一张表而不是塞进 readerPrefs 那个 blob：blob 是整块 LWW 的，
   * 两台设备各调一本不同的书，必然压掉另一台的所有书。按书一行才谈得拢。
   */
  bookPrefs: {
    key: string; // `${pluginId}/${slug}`，和书架同键
    value: { key: string; data: string; updatedAt: number };
  };
  /**
   * 删除墓碑。
   *
   * 没有它，删除只发生在本地：A 设备删了一本漫画，服务端那行还在，
   * A 下次 pull 又被插回书架 —— 表现为"删不掉"。
   * 墓碑让删除成为一种可传播的状态。
   */
  tombstones: {
    key: string;
    value: {
      /** kind + ':' + 被删记录的主键。用 ':' 分隔是因为记录主键含 '/' 但不含 ':' */
      key: string;
      kind: DeleteKind;
      /** 被删记录自己的主键，推给服务端时按它定位 */
      id: string;
      deletedAt: number;
    };
    indexes: { deletedAt: number };
  };
}

/** 可被删除并需要传播的记录类型 */
export type DeleteKind = 'shelf' | 'bookmark' | 'position' | 'lastChapter' | 'plugin';

const DB_NAME = 'zeno-reader';
const DB_VER = 5;

let dbp: Promise<IDBPDatabase<ReaderDB>> | null = null;

export function db(): Promise<IDBPDatabase<ReaderDB>> {
  if (!dbp) {
    dbp = openDB<ReaderDB>(DB_NAME, DB_VER, {
      upgrade(d, old, _new, t) {
        // v1 用的是 sites 表，v2 改名 plugins，v3 加书签与章节缓存，
        // v4 加删除墓碑 + 按 pluginId 的索引
        if (old < 2) {
          const native = d as unknown as IDBDatabase;
          if (native.objectStoreNames.contains('sites')) native.deleteObjectStore('sites');
        }

        /*
         * 已存在的表要走 versionchange 事务拿 store ——
         * IDBDatabase 本身没有 objectStore()，直接在 d 上调会在运行时炸。
         */
        if (!d.objectStoreNames.contains('plugins')) {
          d.createObjectStore('plugins', { keyPath: 'id' }).createIndex('installedAt', 'installedAt');
        }

        if (!d.objectStoreNames.contains('shelf')) {
          const s = d.createObjectStore('shelf', { keyPath: 'key' });
          s.createIndex('addedAt', 'addedAt');
          s.createIndex('pluginId', 'pluginId');
        } else {
          const s = t.objectStore('shelf');
          if (!s.indexNames.contains('pluginId')) s.createIndex('pluginId', 'pluginId');
        }

        if (!d.objectStoreNames.contains('chapters')) {
          d.createObjectStore('chapters', { keyPath: 'key' });
        }

        if (!d.objectStoreNames.contains('bookmarks')) {
          const s = d.createObjectStore('bookmarks', { keyPath: 'key' });
          s.createIndex('createdAt', 'createdAt');
          s.createIndex('pluginId', 'pluginId');
        } else {
          const s = t.objectStore('bookmarks');
          if (!s.indexNames.contains('pluginId')) s.createIndex('pluginId', 'pluginId');
        }

        if (!d.objectStoreNames.contains('chapterCache')) {
          d.createObjectStore('chapterCache', { keyPath: 'key' });
        }
        if (!d.objectStoreNames.contains('settings')) {
          d.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!d.objectStoreNames.contains('bookPrefs')) {
          d.createObjectStore('bookPrefs', { keyPath: 'key' });
        }

        if (!d.objectStoreNames.contains('tombstones')) {
          const s = d.createObjectStore('tombstones', { keyPath: 'key' });
          s.createIndex('deletedAt', 'deletedAt');
        }
      },
    });
  }
  return dbp;
}

/** 删掉某个插件名下的全部数据（书架、缓存、书签、章节表） */
export async function deletePluginData(pluginId: string) {
  const d = await db();
  /*
   * 这几张表的主键都以 `${pluginId}/` 开头，所以用 key range 一次删完，
   * 不用把整表捞进内存再逐条比前缀。
   * \uffff 是 UTF-16 里可比的最大码元，任何同前缀的键都排在它前面。
   */
  const range = IDBKeyRange.bound(`${pluginId}/`, `${pluginId}/\uffff`);
  for (const store of ['shelf', 'chapters', 'bookmarks', 'chapterCache', 'bookPrefs'] as const) {
    const t = d.transaction(store, 'readwrite');
    await t.store.delete(range);
    await t.done;
  }
}
