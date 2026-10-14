import { db } from './db';
import type { DeleteKind, ReaderDB } from './db';

/**
 * 删除墓碑
 *
 * 为什么需要：同步是「推全量 → 拉全量」，而 upsert 只能增不能删。
 * A 设备删掉一本漫画，服务端那行还在，A 下次 pull 它又回来 ——
 * 用户看到的就是「删了又自己冒出来」。书签、进度、插件同理。
 *
 * 墓碑把「删除」变成一个带时间戳、可参与 LWW 的状态。
 */

export type Tombstone = ReaderDB['tombstones']['value'];

/** 墓碑保留多久。超过这个时间所有设备早就同步完了，可以丢 */
const TOMBSTONE_TTL_MS = 1000 * 60 * 60 * 24 * 90;

export async function recordDelete(kind: DeleteKind, id: string): Promise<void> {
  const d = await db();
  await d.put('tombstones', { key: `${kind}:${id}`, kind, id, deletedAt: Date.now() });
}

export async function listTombstones(): Promise<Tombstone[]> {
  return (await db()).getAll('tombstones');
}

/** 顺手回收过期的，避免墓碑无限累积 */
export async function pruneTombstones(): Promise<void> {
  const d = await db();
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const t = d.transaction('tombstones', 'readwrite');
  // deletedAt 上建了索引，按键范围捞主键，不用全表
  const keys = await t.store.index('deletedAt').getAllKeys(IDBKeyRange.upperBound(cutoff, false));
  for (const k of keys) await t.store.delete(k);
  await t.done;
}
