/**
 * LWW 用到的公共件
 *
 * merge（增）和 deletes（删）都要判断「这条数据是不是已经被墓碑删掉了」，
 * 放两边都会重复一份，而重复的判断逻辑早晚不一致 —— 那就变成增和删各按各的规矩。
 */

export function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const GONE_SQL = 'SELECT updated_at FROM deletes WHERE kind = ? AND id = ?';

/** 调用方自己 prepare，循环里不复用会白白多分配一堆语句对象 */
export function goneStmt(d) {
  return d.prepare(GONE_SQL);
}

/**
 * 这条记录是不是已经被墓碑删掉了？
 *
 * 删除也参与 LWW，所以 upsert 必须先问一句。少了这道判断：
 * A 删了一本漫画，还没同步过的 B 下次 push 把手里那份旧数据推上来，
 * 服务端 upsert 只看主表（那行已被删）就直接插回去 —— 删除被复活。
 * 反过来，比墓碑新的写入是「用户又加回去了」，照常接受。
 */
export function goneBefore(gone, kind, id, ts) {
  const row = gone.get(kind, id);
  return !!row && num(row.updated_at) >= ts;
}

/**
 * 删插件要连它名下的书架 / 进度 / 书签一起删。
 *
 * 只删 plugins 那一行的话，剩下这些行按 plugin_id 归属，永远不会再有设备认领，
 * 却又每次 pull 都下发 —— 装了该插件的设备会捞到一堆指向不存在插件的书架条目，
 * 而且它们还会被这些设备重新推回来。
 */
export function dropPluginRows(d, pluginId) {
  for (const table of ['shelf', 'positions', 'last_chapter', 'bookmarks']) {
    d.prepare(`DELETE FROM ${table} WHERE plugin_id = ?`).run(pluginId);
  }
}

/** 记一条墓碑（存在即覆盖为更新的那个时间戳） */
export function stampDelete(d, kind, id, ts, deviceId) {
  d.prepare(
    `INSERT INTO deletes (kind, id, updated_at, device_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(kind, id) DO UPDATE SET
       updated_at = excluded.updated_at, device_id = excluded.device_id`,
  ).run(kind, id, ts, deviceId ?? null);
}
