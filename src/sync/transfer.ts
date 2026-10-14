import { db } from '@/store/db';
import { listPlugins, savePlugin } from '@/store/plugins';
import { getShelf } from '@/store/shelf';
import { getBookmarks } from '@/store/bookmarks';
import type { ShelfEntry } from '@/store/types';

/**
 * 本地数据 ↔ 服务端格式的双向转换
 *
 * 与 client.ts 分开是因为这部分是纯数据搬运，
 * 不该和网络请求、状态管理混在一个文件里。
 */

/** 服务端返回的任意行（字段是 snake_case） */
export type RemoteRow = Record<string, unknown>;

export interface RemoteSnapshot {
  seq: number;
  plugins: RemoteRow[];
  shelf: RemoteRow[];
  positions: RemoteRow[];
  lastChapter: RemoteRow[];
  bookmarks: RemoteRow[];
  settings: RemoteRow[];
}

/** 会同步的 localStorage 键 */
const SYNCED_KEYS = ['themeMode', 'readerPrefs', 'readerMode', 'activePluginId'] as const;

/* ── 本地 → 服务端 ─────────────────────────────────── */

/** 把 IndexedDB + localStorage 整成推送格式 */
export async function collectLocal(): Promise<Record<string, unknown>> {
  const [plugins, shelf, bookmarks] = await Promise.all([
    listPlugins(),
    getShelf(),
    getBookmarks(''),
  ]);

  return {
    plugins: plugins.map((p) => ({
      id: p.id,
      origin: p.origin,
      data: JSON.stringify(p.plugin),
      updatedAt: p.updatedAt ?? p.installedAt,
    })),
    shelf: shelf.map((e) => ({
      pluginId: e.pluginId,
      slug: e.slug,
      title: e.title,
      cover: e.cover,
      addedAt: e.addedAt,
      // 本地书架没有独立的 updatedAt，用 addedAt 兜底。
      // 语义上偏保守：本地改动不会覆盖服务端的更新
      updatedAt: e.addedAt,
    })),
    positions: collectPositions(shelf),
    lastChapter: collectLastChapter(shelf),
    bookmarks: bookmarks.map((b) => ({
      key: b.key,
      pluginId: b.pluginId,
      slug: b.slug,
      chapterId: b.chapterId,
      page: b.page,
      percent: b.percent,
      thumb: b.thumb,
      note: b.note,
      createdAt: b.createdAt,
      updatedAt: b.createdAt,
    })),
    settings: collectSettings(),
  };
}

function collectPositions(shelf: ShelfEntry[]) {
  const now = Date.now();
  const out: { pluginId: string; slug: string; chapterId: string; percent: number; updatedAt: number }[] = [];
  for (const entry of shelf) {
    for (const [chapterId, percent] of Object.entries(entry.positions ?? {})) {
      out.push({
        pluginId: entry.pluginId,
        slug: entry.slug,
        chapterId,
        percent,
        updatedAt: now,
      });
    }
  }
  return out;
}

function collectLastChapter(shelf: ShelfEntry[]) {
  const now = Date.now();
  return shelf
    .filter((e) => e.lastChapterId)
    .map((e) => ({
      pluginId: e.pluginId,
      slug: e.slug,
      chapterId: e.lastChapterId!,
      updatedAt: now,
    }));
}

function collectSettings() {
  return SYNCED_KEYS.map((key) => ({
    key,
    value: localStorage.getItem(key),
    // 单独记一个时间戳，避免每次同步都让所有设置都显得「更新过」
    updatedAt: Number(localStorage.getItem(`${key}__at`) ?? Date.now()),
  })).filter((s) => s.value !== null);
}
/* ── 服务端 → 本地 ─────────────────────────────────── */

/**
 * 把远端快照落进本地。
 *
 * 只写「本地没有的」或「远端时间戳更新的」——
 * 真正的冲突裁决在服务端做过了，这里是无脑落库。
 */
export async function applyRemote(data: RemoteSnapshot): Promise<void> {
  await applyPlugins(data.plugins ?? []);
  await applyShelf(data.shelf ?? []);
  await applyProgress(data);
  await applyBookmarks(data.bookmarks ?? []);
  applySettings(data.settings ?? []);
}

async function applyPlugins(rows: RemoteRow[]) {
  for (const row of rows) {
    try {
      const plugin = JSON.parse(String(row.data));
      if (!plugin?.meta?.id) continue;
      await savePlugin({
        plugin,
        installedAt: Number(row.updated_at ?? Date.now()),
        origin: row.origin === 'local' ? 'local' : 'imported',
      });
    } catch {
      /* 远端数据坏了就跳过，不能覆盖本地好的 */
    }
  }
}

async function applyShelf(rows: RemoteRow[]) {
  const d = await db();
  for (const row of rows) {
    const key = `${row.plugin_id}/${row.slug}`;
    const existing = await d.get('shelf', key);
    const remoteTs = Number(row.updated_at ?? 0);
    if (existing && existing.addedAt >= remoteTs) continue;

    await d.put('shelf', {
      key,
      pluginId: String(row.plugin_id),
      slug: String(row.slug),
      title: String(row.title ?? ''),
      cover: String(row.cover ?? ''),
      // 已有条目保留原添加时间，那决定书架排序
      addedAt: existing?.addedAt ?? Number(row.added_at ?? remoteTs),
      positions: existing?.positions ?? {},
      lastChapterId: existing?.lastChapterId,
    });
  }
}

/**
 * 进度与「读到哪一章」一起处理。
 * 服务端是两张表，这里分别写回本地书架条目的两个字段。
 */
async function applyProgress(data: RemoteSnapshot) {
  const d = await db();

  for (const row of data.positions ?? []) {
    const entry = await d.get('shelf', `${row.plugin_id}/${row.slug}`);
    if (!entry) continue; // 本地没这本漫画，跳过（可能还没导入插件）
    const chapterId = String(row.chapter_id);
    await d.put('shelf', {
      ...entry,
      positions: { ...entry.positions, [chapterId]: Number(row.percent ?? 0) },
    });
  }

  for (const row of data.lastChapter ?? []) {
    const entry = await d.get('shelf', `${row.plugin_id}/${row.slug}`);
    if (!entry) continue;
    await d.put('shelf', { ...entry, lastChapterId: String(row.chapter_id) });
  }

  void d;
}

async function applyBookmarks(rows: RemoteRow[]) {
  const d = await db();
  for (const row of rows) {
    const key = String(row.key ?? '');
    if (!key) continue;
    const existing = await d.get('bookmarks', key);
    const remoteTs = Number(row.updated_at ?? 0);
    if (existing && existing.createdAt >= remoteTs) continue;

    await d.put('bookmarks', {
      key,
      pluginId: String(row.plugin_id ?? ''),
      slug: String(row.slug ?? ''),
      chapterId: String(row.chapter_id ?? ''),
      page: Number(row.page ?? 0),
      percent: Number(row.percent ?? 0),
      thumb: (row.thumb as string) || undefined,
      note: (row.note as string) || undefined,
      createdAt: Number(row.created_at ?? remoteTs),
    });
  }
}

function applySettings(rows: RemoteRow[]) {
  for (const row of rows) {
    const key = String(row.key ?? '');
    const value = row.value;
    if (!key || value == null) continue;

    // 本地更新时间比远端新就不覆盖
    const localAt = Number(localStorage.getItem(`${key}__at`) ?? 0);
    const remoteAt = Number(row.updated_at ?? 0);
    if (localAt > remoteAt) continue;

    localStorage.setItem(key, String(value));
    localStorage.setItem(`${key}__at`, String(remoteAt || Date.now()));
  }
}
