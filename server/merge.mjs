import { logChange, openDb } from './db.mjs';

/**
 * 合并策略
 *
 * 单用户多设备，同步的核心问题是「两边都改了一条记录，听谁的」。
 * 全部用「updated_at 时间戳大者胜」，简单且能收敛。
 *
 * 关键性质：**合并是幂等且可交换的**。
 * A 推给 B、B 再推给 A，结果一致；不会来回震荡。
 * 时钟不准只会导致「最近写的赢」，不会导致数据丢失或重复。
 */

/** 取两组记录里 updated_at 更大的那条。相等时取本地（避免无意义写入） */
function newer(local, remote) {
  if (!remote) return local;
  if (!local) return remote;
  return remote.updated_at > local.updated_at ? remote : local;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ── 插件 ─────────────────────────────────────────── */

/**
 * 插件按 id 合并。
 * data 是完整 JSON，冲突时整份取新 —— 插件内部结构复杂，逐字段合并不划算。
 */
export function upsertPlugins(rows, deviceId) {
  const d = openDb();
  const stmt = d.prepare(
    `SELECT updated_at FROM plugins WHERE id = ?
     UNION ALL SELECT updated_at FROM plugins WHERE id = ?`,
  );

  let changed = 0;
  const apply = d.prepare(
    `INSERT INTO plugins (id, origin, data, updated_at, device_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       origin = excluded.origin, data = excluded.data,
       updated_at = excluded.updated_at, device_id = excluded.device_id`,
  );
  const touch = d.prepare('SELECT updated_at FROM plugins WHERE id = ?');

  for (const r of rows ?? []) {
    if (!r?.id) continue;
    const local = touch.get(r.id);
    const ts = num(r.updatedAt, Date.now());
    // 本地更新则跳过，避免无谓写入与 seq 膨胀
    if (local && num(local.updated_at) >= ts) continue;
    apply.run(r.id, r.origin === 'local' ? 'local' : 'imported', r.data, ts, deviceId ?? null);
    changed++;
  }
  if (changed) logChange('plugin', deviceId);
  return changed;
}

/**
 * 插件：集合式合并 + 显式删除
 *
 * 插件是「整机一份」的语义（不像书架可以有不同漫画），
 * 所以需要支持删除传播：某台设备删了插件，其他设备下次同步也要跟着删。
 * upsert 只能增不能删，所以补一个 removePlugin。
 */
export function removePlugin(id, deviceId) {
  const d = openDb();
  const existing = d.prepare('SELECT id FROM plugins WHERE id = ?').get(id);
  if (!existing) return false;
  d.prepare('DELETE FROM plugins WHERE id = ?').run(id);
  logChange('plugin', deviceId);
  return true;
}

/* ── 书架 ─────────────────────────────────────────── */

/** 集合式合并：按 (pluginId, slug) 取新 */
export function upsertShelf(rows, deviceId) {
  const d = openDb();
  const touch = d.prepare('SELECT updated_at FROM shelf WHERE plugin_id = ? AND slug = ?');
  const apply = d.prepare(
    `INSERT INTO shelf (plugin_id, slug, title, cover, added_at, updated_at, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(plugin_id, slug) DO UPDATE SET
       title = excluded.title, cover = excluded.cover,
       updated_at = excluded.updated_at, device_id = excluded.device_id`,
  );

  let changed = 0;
  for (const r of rows ?? []) {
    if (!r?.pluginId || !r?.slug) continue;
    const local = touch.get(r.pluginId, r.slug);
    const ts = num(r.updatedAt, Date.now());
    if (local && num(local.updated_at) >= ts) continue;
    apply.run(
      r.pluginId,
      r.slug,
      r.title ?? '',
      r.cover ?? '',
      num(r.addedAt, ts),
      ts,
      deviceId ?? null,
    );
    changed++;
  }
  if (changed) logChange('shelf', deviceId);
  return changed;
}

/* ── 阅读进度 ─────────────────────────────────────── */

/**
 * 进度是标量，取新即可。
 * 特殊处理：percent = 100 表示「读完了」，不要被后来的小值覆盖回未读完。
 */
export function upsertPositions(rows, deviceId) {
  const d = openDb();
  const touch = d.prepare(
    'SELECT percent, updated_at FROM positions WHERE plugin_id = ? AND slug = ? AND chapter_id = ?',
  );
  const apply = d.prepare(
    `INSERT INTO positions (plugin_id, slug, chapter_id, percent, updated_at, device_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(plugin_id, slug, chapter_id) DO UPDATE SET
       percent = excluded.percent, updated_at = excluded.updated_at,
       device_id = excluded.device_id`,
  );

  let changed = 0;
  for (const r of rows ?? []) {
    if (!r?.pluginId || !r?.slug || !r?.chapterId) continue;
    const local = touch.get(r.pluginId, r.slug, r.chapterId);
    if (!local) {
      apply.run(
        r.pluginId,
        r.slug,
        r.chapterId,
        Math.round(num(r.percent)),
        num(r.updatedAt, Date.now()),
        deviceId ?? null,
      );
      changed++;
      continue;
    }

    const remotePct = Math.round(num(r.percent));
    const localPct = num(local.percent);
    const ts = num(r.updatedAt, Date.now());

    if (localPct === 100 && remotePct < 100) continue; // 已读完的别被拉回去
    if (num(local.updated_at) >= ts && localPct >= remotePct) continue;

    apply.run(r.pluginId, r.slug, r.chapterId, remotePct, ts, deviceId ?? null);
    changed++;
  }
  if (changed) logChange('position', deviceId);
  return changed;
}

/** 「读到哪一章」 */
export function upsertLastChapter(rows, deviceId) {
  const d = openDb();
  const touch = d.prepare(
    'SELECT updated_at FROM last_chapter WHERE plugin_id = ? AND slug = ?',
  );
  const apply = d.prepare(
    `INSERT INTO last_chapter (plugin_id, slug, chapter_id, updated_at, device_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(plugin_id, slug) DO UPDATE SET
       chapter_id = excluded.chapter_id, updated_at = excluded.updated_at,
       device_id = excluded.device_id`,
  );

  let changed = 0;
  for (const r of rows ?? []) {
    if (!r?.pluginId || !r?.slug || !r?.chapterId) continue;
    const local = touch.get(r.pluginId, r.slug);
    const ts = num(r.updatedAt, Date.now());
    if (local && num(local.updated_at) >= ts) continue;
    apply.run(r.pluginId, r.slug, r.chapterId, ts, deviceId ?? null);
    changed++;
  }
  if (changed) logChange('position', deviceId);
  return changed;
}

/* ── 书签 ─────────────────────────────────────────── */

export function upsertBookmarks(rows, deviceId) {
  const d = openDb();
  const touch = d.prepare('SELECT updated_at FROM bookmarks WHERE key = ?');
  const apply = d.prepare(
    `INSERT INTO bookmarks
       (key, plugin_id, slug, chapter_id, page, percent, thumb, note, created_at, updated_at, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       percent = excluded.percent, thumb = excluded.thumb, note = excluded.note,
       updated_at = excluded.updated_at, device_id = excluded.device_id`,
  );

  let changed = 0;
  for (const r of rows ?? []) {
    if (!r?.key) continue;
    const local = touch.get(r.key);
    const ts = num(r.updatedAt, Date.now());
    if (local && num(local.updated_at) >= ts) continue;
    apply.run(
      r.key,
      r.pluginId ?? '',
      r.slug ?? '',
      r.chapterId ?? '',
      num(r.page),
      num(r.percent),
      r.thumb ?? null,
      r.note ?? null,
      num(r.createdAt, ts),
      ts,
      deviceId ?? null,
    );
    changed++;
  }
  if (changed) logChange('bookmark', deviceId);
  return changed;
}

/* ── 设置（主题 / 阅读偏好 / 活动插件） ───────────── */

export function upsertSettings(rows, deviceId) {
  const d = openDb();
  const touch = d.prepare('SELECT updated_at FROM settings WHERE key = ?');
  const apply = d.prepare(
    `INSERT INTO settings (key, value, updated_at, device_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value, updated_at = excluded.updated_at,
       device_id = excluded.device_id`,
  );

  let changed = 0;
  for (const r of rows ?? []) {
    if (!r?.key) continue;
    const local = touch.get(r.key);
    const ts = num(r.updatedAt, Date.now());
    if (local && num(local.updated_at) >= ts) continue;
    apply.run(r.key, r.value, ts, deviceId ?? null);
    changed++;
  }
  if (changed) logChange('setting', deviceId);
  return changed;
}

/* ── 批量推送 ─────────────────────────────────────── */

/**
 * 客户端一次推全部。
 * 返回实际接受的条数，供 UI 显示「同步了 N 项」。
 */
export function pushAll(payload, deviceId) {
  const n = {
    plugins: upsertPlugins(payload.plugins, deviceId),
    shelf: upsertShelf(payload.shelf, deviceId),
    positions: upsertPositions(payload.positions, deviceId),
    lastChapter: upsertLastChapter(payload.lastChapter, deviceId),
    bookmarks: upsertBookmarks(payload.bookmarks, deviceId),
    settings: upsertSettings(payload.settings, deviceId),
  };
  return {
    ...n,
    total: Object.values(n).reduce((a, b) => a + b, 0),
  };
}
