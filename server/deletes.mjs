import { logChange, openDb } from './db.mjs';
import { dropPluginRows, num, stampDelete } from './lww.mjs';

/**
 * 删除的传播
 *
 * 同步是「推全量 → 拉全量」，upsert 只能增不能删。没有墓碑的话，
 * A 设备删掉的东西会被 B 设备下一次 push 原样推回来 —— 用户看到的就是删不掉。
 *
 * 服务端存两份：`deletes` 表记墓碑，主表记还在的数据。
 * 增的一侧（merge.mjs）会来查墓碑，删的一侧在这里。
 */

/*
 * 被删记录的主键里可能含 '/'（slug 是从 URL 里正则抓出来的，插件作者写成
 * 带路径的 slug 也合法），所以不能按 split('/') 的段数定位字段 ——
 * 按首段 / 尾段切，中间全归 slug。
 */
function splitTwo(id) {
  const i = id.indexOf('/');
  return i < 0 ? [] : [id.slice(0, i), id.slice(i + 1)];
}
function splitThree(id) {
  const a = id.indexOf('/');
  const b = id.lastIndexOf('/');
  return b <= a ? [] : [id.slice(0, a), id.slice(a + 1, b), id.slice(b + 1)];
}

/** 被删记录在主表里的主键列组合，按 kind 映射 */
const DELETE_TARGETS = {
  shelf: { table: 'shelf', cols: ['plugin_id', 'slug'], split: splitTwo },
  bookmark: { table: 'bookmarks', cols: ['key'], split: (id) => [id] },
  plugin: { table: 'plugins', cols: ['id'], split: (id) => [id] },
  position: { table: 'positions', cols: ['plugin_id', 'slug', 'chapter_id'], split: splitThree },
  lastChapter: { table: 'last_chapter', cols: ['plugin_id', 'slug'], split: splitTwo },
};

/**
 * 应用客户端推来的墓碑。
 *
 * 两层时间戳比较，缺一个都会出问题：
 *   1. 跟已有墓碑比 —— 更旧的删除不该再触发一次
 *   2. 跟主表现存数据比 —— pushAll 是「先增后删」，同一批里可能既有
 *      「我又加回了这本书」(T3) 又有「我曾删过它」(T2)；不看这一层，
 *      后执行的删除会把前者抹掉，而且每轮同步都抹一次，
 *      表现就是这本书再也加不上。
 *
 * 墓碑无论如何都记下来：它比现存数据旧时不会挡住后来的写入，
 * 但能挡住那些还停在删除之前的设备把旧数据推回来。
 */
export function applyDeletes(rows, deviceId) {
  const d = openDb();
  const touch = d.prepare('SELECT updated_at FROM deletes WHERE kind = ? AND id = ?');

  let changed = 0;
  for (const r of rows ?? []) {
    const kind = r?.kind;
    const target = DELETE_TARGETS[kind];
    if (!target || !r.id) continue;

    const ts = num(r.deletedAt ?? r.updatedAt, Date.now());
    const local = touch.get(kind, r.id);
    if (local && num(local.updated_at) >= ts) continue;

    const id = String(r.id);
    const parts = target.split(id);
    if (parts.length !== target.cols.length || parts.some((p) => !p)) continue;
    const where = target.cols.map((c) => `${c} = ?`).join(' AND ');

    const cur = d.prepare(`SELECT updated_at FROM ${target.table} WHERE ${where}`).get(...parts);
    if (!cur || num(cur.updated_at) <= ts) {
      d.prepare(`DELETE FROM ${target.table} WHERE ${where}`).run(...parts);
      if (kind === 'plugin') dropPluginRows(d, id);
      changed++;
    }
    stampDelete(d, kind, id, ts, deviceId);
  }
  if (changed) logChange('delete', deviceId);
  return changed;
}

/**
 * 显式删插件的接口（客户端删插件时直接调，不等下一轮全量推送）。
 *
 * 插件是「整机一份」的语义（不像书架可以有不同漫画），删除必须马上扩散，
 * 否则其他设备下次同步还会看到这个插件、还能继续用它的解析规则抓站。
 */
export function removePlugin(id, deviceId) {
  const d = openDb();
  const existing = d.prepare('SELECT id FROM plugins WHERE id = ?').get(id);
  if (!existing) return false;
  d.prepare('DELETE FROM plugins WHERE id = ?').run(id);
  dropPluginRows(d, id);
  stampDelete(d, 'plugin', id, Date.now(), deviceId);
  logChange('plugin', deviceId);
  return true;
}
