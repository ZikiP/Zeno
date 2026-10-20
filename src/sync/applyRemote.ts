import { db, deletePluginData } from '@/store/db';
import type { Bookmark, DeleteKind, InstalledPlugin, ReaderDB } from '@/store/db';
import type { ShelfEntry } from '@/store/types';
import type { Plugin } from '@/site/types';
import type { IDBPTransaction } from 'idb';
import type { RemoteRow, RemoteSnapshot } from './transfer';
import { serverNow } from './clock';

/**
 * 把服务端快照落进本地
 *
 * 从 transfer.ts 拆出来是因为「本地 → 服务端」和「服务端 → 本地」
 * 是两件事，混在一个文件里两边都难读。
 *
 * 全程跑在**一个** IndexedDB 事务里。之前是逐行各开各的事务，
 * 中途抛异常就留下半新半旧的本地状态，而且 emitDataChange 也不会触发 ——
 * UI 继续显示旧数据，用户完全看不出同步半途而废了。
 */

const STORES = ['plugins', 'shelf', 'bookmarks', 'tombstones', 'bookPrefs'] as const;
type Stores = typeof STORES;
type Tx = IDBPTransaction<ReaderDB, Stores, 'readwrite'>;

export async function applyRemote(data: RemoteSnapshot): Promise<void> {
  const d = await db();
  const t = d.transaction(STORES, 'readwrite');

  /*
   * 事务里只 await IDB 请求。中途 await 任何非 IDB 的 promise，
   * 浏览器会认为事务已空闲并自动提交，后续请求直接抛 TransactionInactiveError。
   * 所以 localStorage 的写入放在事务之外。
   */
  await applyPlugins(t, data.plugins ?? []);
  await applyShelf(t, data.shelf ?? []);
  await applyProgress(t, data.positions ?? [], data.lastChapter ?? []);
  await applyBookmarks(t, data.bookmarks ?? []);
  await applyBookPrefs(t, data.bookPrefs ?? []);
  /*
   * 删除放在最后：快照里"还存在"的行先落库，然后才按墓碑清理。
   * 反过来会先删掉、再被同一批里的旧数据加回来。
   */
  const deletedPlugins = await applyDeletes(t, data.deletes ?? []);

  await t.done;

  applySettings(data.settings ?? []);
  /*
   * 插件删掉后要连它名下的书架/书签/缓存一起清，否则留下孤儿数据 ——
   * 那些行还会被下次 push 传回服务端，把已经删掉的漫画复活。
   * 这几张表不在本事务范围内，只能放在事务外。
   */
  for (const id of deletedPlugins) await deletePluginData(id);
}

async function applyPlugins(t: Tx, rows: RemoteRow[]) {
  const store = t.objectStore('plugins');
  for (const row of rows) {
    const id = String(row.id ?? '');
    if (!id) continue;

    let plugin: Plugin;
    try {
      plugin = JSON.parse(String(row.data));
    } catch {
      continue; /* 远端数据坏了就跳过，不能覆盖本地好的 */
    }
    if (plugin?.meta?.id !== id) continue;

    const remoteTs = Number(row.updated_at ?? 0);
    const existing = await store.get(id);
    if (existing && (existing.updatedAt ?? existing.installedAt) >= remoteTs) continue;

    const value: InstalledPlugin = {
      id,
      plugin,
      origin: row.origin === 'local' ? 'local' : 'imported',
      // 已装的要保留原安装时间，那决定插件列表的排序
      installedAt: existing?.installedAt ?? (remoteTs || serverNow()),
      updatedAt: remoteTs,
    };
    await store.put(value);
  }
}

async function applyShelf(t: Tx, rows: RemoteRow[]) {
  const store = t.objectStore('shelf');
  for (const row of rows) {
    const pluginId = String(row.plugin_id ?? '');
    const slug = String(row.slug ?? '');
    if (!pluginId || !slug) continue;

    const key = `${pluginId}/${slug}`;
    const existing = await store.get(key);
    const remoteTs = Number(row.updated_at ?? 0);
    // 比的是 updatedAt，不是 addedAt —— 后者要留给书架排序，两者用途不同
    if (existing && (existing.updatedAt ?? existing.addedAt) >= remoteTs) continue;

    const value: ShelfEntry = {
      key,
      pluginId,
      slug,
      title: String(row.title ?? ''),
      cover: String(row.cover ?? ''),
      // 已有条目保留原添加时间，那决定书架排序
      addedAt: existing ? existing.addedAt : Number(row.added_at ?? remoteTs),
      /*
       * 手动顺序：远端没带值时保住本地已有的 —— 服务端那列可能是 NULL
       * （另一台设备还没拖拽过），直接覆盖会把这里排好的顺序清空。
       */
      order: row.sort_order === null || row.sort_order === undefined
        ? existing?.order
        : Number(row.sort_order),
      updatedAt: remoteTs,
      positions: existing?.positions ?? {},
      positionsAt: existing?.positionsAt,
      lastChapterId: existing?.lastChapterId,
      lastChapterAt: existing?.lastChapterAt,
    };
    await store.put(value);
  }
}

/**
 * 单书显示偏好：按 (pluginId, slug) 一行，各自 LWW。
 *
 * 服务端没这一行的时候本地保留原样 —— 别用"远端没提就是没有"的语义，
 * 那等于任何一次不带该实体的推送都会清空所有书的设置。
 */
async function applyBookPrefs(t: Tx, rows: RemoteRow[]) {
  const store = t.objectStore('bookPrefs');
  for (const row of rows) {
    const pluginId = String(row.plugin_id ?? '');
    const slug = String(row.slug ?? '');
    if (!pluginId || !slug) continue;
    const key = `${pluginId}/${slug}`;
    const remoteTs = Number(row.updated_at ?? 0);
    const existing = await store.get(key);
    if (existing && existing.updatedAt >= remoteTs) continue;
    await store.put({ key, data: String(row.data ?? '{}'), updatedAt: remoteTs });
  }
}

/**
 * 进度与「读到哪一章」一起处理。
 * 服务端是两张表，这里分别写回本地书架条目的两个字段。
 */
async function applyProgress(t: Tx, positions: RemoteRow[], lastChapter: RemoteRow[]) {
  const store = t.objectStore('shelf');

  for (const row of positions) {
    const entry = await store.get(`${row.plugin_id}/${row.slug}`);
    if (!entry) continue; // 本地没这本漫画，跳过（可能还没导入插件）
    const chapterId = String(row.chapter_id);
    const at = Number(row.updated_at ?? 0);
    await store.put({
      ...entry,
      positions: { ...entry.positions, [chapterId]: Number(row.percent ?? 0) },
      // 带上服务端的时间戳，别在本地又刷成 now —— 那会重新引入
      // "每次同步所有进度都显得刚更新过"的问题
      positionsAt: { ...entry.positionsAt, [chapterId]: at || entry.positionsAt?.[chapterId] || 0 },
    });
  }

  for (const row of lastChapter) {
    const entry = await store.get(`${row.plugin_id}/${row.slug}`);
    if (!entry) continue;
    const at = Number(row.updated_at ?? 0);
    /*
     * 服务端可能还没这两个数（老数据，或推的一侧算不出来）。
     * 缺值时保住本地已有的，别一路同步就把进度底子抹成不知道。
     */
    const idx = row.chapter_index == null ? undefined : Number(row.chapter_index);
    const cnt = row.chapter_count == null ? undefined : Number(row.chapter_count);
    await store.put({
      ...entry,
      lastChapterId: String(row.chapter_id),
      lastChapterAt: at || entry.lastChapterAt || 0,
      chapterIndex: idx ?? entry.chapterIndex,
      chapterCount: cnt ?? entry.chapterCount,
    });
  }
}

async function applyBookmarks(t: Tx, rows: RemoteRow[]) {
  const store = t.objectStore('bookmarks');
  for (const row of rows) {
    const key = String(row.key ?? '');
    if (!key) continue;
    const existing = await store.get(key);
    const remoteTs = Number(row.updated_at ?? 0);
    if (existing && (existing.updatedAt ?? existing.createdAt) >= remoteTs) continue;

    const value: Bookmark = {
      key,
      pluginId: String(row.plugin_id ?? ''),
      slug: String(row.slug ?? ''),
      chapterId: String(row.chapter_id ?? ''),
      page: Number(row.page ?? 0),
      percent: Number(row.percent ?? 0),
      thumb: (row.thumb as string) || undefined,
      note: (row.note as string) || undefined,
      createdAt: Number(row.created_at ?? remoteTs),
      updatedAt: remoteTs,
    };
    await store.put(value);
  }
}

/**
 * 本地能处理的删除类型。用类型谓词而不是 cast ——
 * 服务端表里还有 lastChapter，但客户端没有任何路径会产生它，
 * 收到就忽略，不必为不存在的写入方编一段处理。
 */
function isHandled(kind: unknown): kind is DeleteKind {
  return kind === 'shelf' || kind === 'bookmark' || kind === 'plugin' || kind === 'position';
}

/**
 * 按服务端墓碑删本地。
 *
 * **删除也参与 LWW**：墓碑带时间戳，只有比本地记录更新才真删。
 * 少了这一步判断，「删掉一本漫画 → 又重新加回去」会被后面每轮 pull
 * 再删一次 —— 因为墓碑不会消失，用户看到的就是这本书怎么也加不上。
 */
async function applyDeletes(t: Tx, rows: NonNullable<RemoteSnapshot['deletes']>): Promise<string[]> {
  const shelf = t.objectStore('shelf');
  const bookmarks = t.objectStore('bookmarks');
  const plugins = t.objectStore('plugins');
  const tombstones = t.objectStore('tombstones');
  const pluginIds: string[] = [];

  for (const row of rows) {
    const id = String(row.id ?? '');
    if (!id || !isHandled(row.kind)) continue;
    const delAt = Number(row.updated_at ?? 0);

    let stale = false;
    if (row.kind === 'shelf') {
      const existing = await shelf.get(id);
      stale = !!existing && (existing.updatedAt ?? existing.addedAt) > delAt;
      if (!stale) await shelf.delete(id);
    } else if (row.kind === 'bookmark') {
      const existing = await bookmarks.get(id);
      stale = !!existing && (existing.updatedAt ?? existing.createdAt) > delAt;
      if (!stale) await bookmarks.delete(id);
    } else if (row.kind === 'plugin') {
      const existing = await plugins.get(id);
      if (existing && (existing.updatedAt ?? existing.installedAt) > delAt) stale = true;
      else {
        await plugins.delete(id);
        pluginIds.push(id);
      }
    } else {
      /*
       * 进度不是独立表，是书架条目里的一个 map key。
       * id 形如 `${pluginId}/${slug}/${chapterId}`，slug 本身可能含 '/'，
       * 所以按最后一个 '/' 切，前半段直接就是书架的主键。
       */
      const cut = id.lastIndexOf('/');
      if (cut < 0) continue;
      const entry = await shelf.get(id.slice(0, cut));
      const cid = id.slice(cut + 1);
      if (entry?.positions?.[cid]) {
        if ((entry.positionsAt?.[cid] ?? 0) > delAt) stale = true;
        else {
          const positions = { ...entry.positions };
          const positionsAt = { ...entry.positionsAt };
          delete positions[cid];
          delete positionsAt[cid];
          await shelf.put({ ...entry, positions, positionsAt });
        }
      }
    }
    if (stale) continue;

    // 本地也要有墓碑，否则这台设备下次 push 时又把这条当"我还有的数据"传回去。
    // 时间戳沿用服务端那个，别现算 now —— 那会把这条删除人为顶到最新。
    await tombstones.put({
      key: `${row.kind}:${id}`,
      kind: row.kind,
      id,
      deletedAt: delAt || serverNow(),
    });
  }
  return pluginIds;
}

/** 超过「现在 + 10 分钟」的时间戳一律当成坏时钟，不参与 LWW */
const FUTURE_SKEW_MS = 10 * 60_000;

function applySettings(rows: RemoteRow[]) {
  const now = serverNow();
  const horizon = now + FUTURE_SKEW_MS;
  /*
   * 一台时钟快出几天的设备能把设置键顶到未来，之后所有设备的正常修改
   * 都会输给这条"未来"记录，而且它自己也会一直赢。这里把离谱的未来时间
   * 归零：本地坏时间戳会让位给一条正常的远端记录（顺带把本地 `__at` 掰回来），
   * 远端坏时间戳也不会压掉本地正常的选择。
   */
  const sane = (t: number) => (t > horizon ? 0 : t);

  for (const row of rows) {
    const key = String(row.key ?? '');
    const value = row.value;
    if (!key || value == null) continue;

    // 本地更新时间比远端新就不覆盖
    const localAt = sane(Number(localStorage.getItem(`${key}__at`) ?? 0));
    const remoteAt = sane(Number(row.updated_at ?? 0));
    if (localAt > remoteAt) continue;

    localStorage.setItem(key, String(value));
    localStorage.setItem(`${key}__at`, String(remoteAt || now));
  }
}
