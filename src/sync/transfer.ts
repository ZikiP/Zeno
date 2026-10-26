import { listPlugins } from '@/store/plugins';
import { listBookPrefs } from '@/store/bookPrefs';
import { getShelf } from '@/store/shelf';
import { getBookmarks } from '@/store/bookmarks';
import { listTombstones } from '@/store/tombstones';
import { listBookModeSettings } from './bookModes';
import { serverNow } from './clock';
import type { ShelfEntry } from '@/store/types';

/**
 * 本地数据 → 服务端格式
 *
 * 反方向（服务端 → 本地）在 applyRemote.ts。
 * 拆开是因为这两半各自都要处理冲突、顺序、级联，混在一起两头都读不清；
 * 而且它们碰存储的方式完全不同 —— 这边只读，那边要写事务。
 */

/** 服务端返回的任意行（字段是 snake_case） */
export type RemoteRow = Record<string, unknown>;

export interface RemoteSnapshot {
  seq: number;
  /** 服务端盖响应那一刻的挂钟，客户端用它把自己的钟挪到同一条时间轴上（见 clock.ts） */
  serverTime?: number;
  plugins: RemoteRow[];
  shelf: RemoteRow[];
  positions: RemoteRow[];
  lastChapter: RemoteRow[];
  bookmarks: RemoteRow[];
  settings: RemoteRow[];
  /** 每本书自己的显示偏好，一行一本 */
  bookPrefs?: RemoteRow[];
  deletes?: { kind: string; id: string; updated_at: number }[];
}

/** 会同步的 localStorage 键 */
const SYNCED_KEYS = [
  'themeMode',
  'readerPrefs',
  /*
   * 旧的全局阅读方式。新客户端读 readerPrefs.mode，写的时候仍镜像这一份，
   * 让还没升级的客户端至少能继续收到全局默认值；都升级后可删。
   */
  'readerMode',
  'enabledPluginIds',
  // 书架排法与格子数：换设备打开应该看到同一个架子（格子数按各设备自己的视口取用）
  'shelfSort',
  'shelfColsSm',
  'shelfColsLg',
  // 界面字体：字体文件由服务端供给，任何设备都拉得到，所以选择跟着账号走
  'uiFont',
] as const;

/* ── 本地 → 服务端 ─────────────────────────────────── */

/** 把 IndexedDB + localStorage 整成推送格式 */
export async function collectLocal(): Promise<Record<string, unknown>> {
  const [plugins, shelf, bookmarks, tombstones, bookPrefs] = await Promise.all([
    listPlugins(),
    getShelf(),
    getBookmarks(''),
    listTombstones(),
    listBookPrefs(),
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
      // 手动顺序。没排过就是 null —— 服务端用 COALESCE 保住原值，
      // 免得一台从没拖拽过的设备把别处排好的顺序抹掉。
      order: e.order ?? null,
      // LWW 时钟用 updatedAt；没写过的旧数据退回 addedAt，
      // 但绝不能退回 Date.now() —— 那等于每轮同步都宣称"我这份最新"，
      // 会把别处的删除和更新统统压掉。
      updatedAt: e.updatedAt ?? e.addedAt,
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
      // 用真实的修改时间。用 createdAt 的话，改了笔记也永远"不比服务端新"。
      updatedAt: b.updatedAt ?? b.createdAt,
    })),
    /* 一行一本。拆成这个粒度而不是并进 readerPrefs 那个 blob，
       是为了让"我在平板上调了书 A、手机上调了书 B"两件事都能活下来。 */
    bookPrefs: bookPrefs.map((r) => {
      const [pluginId, ...rest] = r.key.split('/');
      return { pluginId, slug: rest.join('/'), data: r.data, updatedAt: r.updatedAt };
    }),
    settings: collectSettings(),
    deletes: tombstones.map((t) => ({ kind: t.kind, id: t.id, deletedAt: t.deletedAt })),
  };
}

/**
 * 进度时间戳取自记录本身。
 *
 * 之前这里是现算 Date.now()：于是每 5 分钟一轮同步就把**所有**进度
 * 刷成"刚刚更新过"，服务端 change_log 无意义膨胀，
 * LWW 也退化成"最近同步的那台赢"而不是"真的改过的那台赢"。
 * 没有记录过时间的旧数据，退回 addedAt 而不是 now，避免凭空变最新。
 */
function collectPositions(shelf: ShelfEntry[]) {
  const out: { pluginId: string; slug: string; chapterId: string; percent: number; updatedAt: number }[] = [];
  for (const entry of shelf) {
    for (const [chapterId, percent] of Object.entries(entry.positions ?? {})) {
      out.push({
        pluginId: entry.pluginId,
        slug: entry.slug,
        chapterId,
        percent,
        updatedAt: entry.positionsAt?.[chapterId] ?? entry.addedAt,
      });
    }
  }
  return out;
}

function collectLastChapter(shelf: ShelfEntry[]) {
  return shelf
    .filter((e) => e.lastChapterId)
    .map((e) => ({
      pluginId: e.pluginId,
      slug: e.slug,
      chapterId: e.lastChapterId!,
      updatedAt: e.lastChapterAt ?? e.addedAt,
      // 「第几章 / 共几章」：新设备没有章节表缓存也能算出全书进度。
      // 没算出来就推 null，服务端用 COALESCE 保住别处存好的值。
      chapterIndex: e.chapterIndex ?? null,
      chapterCount: e.chapterCount ?? null,
    }));
}

function collectSettings() {
  return [
    ...SYNCED_KEYS.map((key) => ({
      key,
      value: localStorage.getItem(key),
      // 单独记一个时间戳，避免每次同步都让所有设置都显得「更新过」
      updatedAt: Number(localStorage.getItem(`${key}__at`) ?? serverNow()),
    })),
    /* 每本书的阅读方式是动态键，各自带 __at，和全局设置共用同一张表 */
    ...listBookModeSettings(),
  ].filter((s) => s.value !== null);
}
