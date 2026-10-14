import { db, deletePluginData } from './db';
import { recordDelete } from './tombstones';
import { PLUGIN_FORMAT, PLUGIN_TEMPLATE, type Plugin } from '@/site/types';
import type { InstalledPlugin } from './db';

/** 插件的增删改查与启用状态 */

export async function listPlugins(): Promise<InstalledPlugin[]> {
  const all = await (await db()).getAll('plugins');
  return all.sort((a, b) => a.installedAt - b.installedAt);
}

export async function getPlugin(id: string): Promise<InstalledPlugin | undefined> {
  return (await db()).get('plugins', id);
}

/** 新增或覆盖。已存在时保留 installedAt，刷新 updatedAt */
export async function savePlugin(
  item: Omit<InstalledPlugin, 'id' | 'updatedAt'>,
): Promise<void> {
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

/**
 * 删除插件。
 *
 * 除了删本地，还要通知服务端 —— 否则服务端那份永远留着，
 * 白名单不会移除，其他设备同步时也删不掉。
 * 同步没开时请求会失败，忽略即可，不影响本地删除。
 */
export async function deletePlugin(id: string): Promise<void> {
  await (await db()).delete('plugins', id);
  await deletePluginData(id);
  // 墓碑：光删服务端那一行不够，还得让"这个插件被删了"这个事实可传播，
  // 否则其他设备本地的 IndexedDB 副本会一直留着。
  await recordDelete('plugin', id);

  try {
    const endpoint = localStorage.getItem('syncEndpoint') ?? location.origin;
    // 必须带令牌。设了 SYNC_TOKEN 时这个请求以前是裸的，
    // 结果 401 被 catch 静默吞掉 —— 本地删了，服务端还留着，白名单不移除。
    // 直接读键而不是 import getSyncToken()：client → transfer → plugins 已经成链，
    // 再反向引一次就是循环导入。
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('syncToken');
    if (token) headers.Authorization = `Bearer ${token}`;
    await fetch(`${endpoint}/api/sync/forget-plugin`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id, deviceId: localStorage.getItem('syncDeviceId') ?? undefined }),
    });
  } catch {
    /* 没开同步或连不上，本地已删，够了 */
  }
}

/** 取当前启用的插件；没有就用第一个；一个都没有返回 null（引导用户导入） */
export async function getActivePlugin(): Promise<Plugin | null> {
  const all = await listPlugins();
  if (all.length === 0) return null;

  const activeId = getActivePluginId();
  if (activeId) {
    const found = all.find((p) => p.plugin.meta.id === activeId);
    if (found) return found.plugin;
  }
  setActivePluginId(all[0].plugin.meta.id);
  return all[0].plugin;
}

/**
 * 当前启用的插件 id。
 *
 * 存在 localStorage 而不是 IndexedDB 的 settings 表 —— 因为它在 SYNCED_KEYS 里，
 * 而 collectSettings() 读的是 localStorage。之前两边不一致，
 * 结果这个键被声明为同步项却永远同步不出去（值恒为 null，被 filter 掉）。
 *
 * `__at` 后缀是同步层给每个键记的写入时间，LWW 要用它，
 * 缺了它每次同步所有设置都显得"刚刚更新过"。
 */
const ACTIVE_KEY = 'activePluginId';

export function getActivePluginId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActivePlugin(id: string): void {
  localStorage.setItem(ACTIVE_KEY, id);
  localStorage.setItem(`${ACTIVE_KEY}__at`, String(Date.now()));
}

/** @deprecated 用 setActivePlugin，保留是为了不破坏既有调用点 */
export const setActivePluginId = setActivePlugin;

/** 新建空白插件的模板 */
export function newPluginTemplate(name: string): Plugin {
  return {
    format: PLUGIN_FORMAT,
    meta: { id: `local-${Date.now().toString(36)}`, name, version: '0.1.0' },
    entry: PLUGIN_TEMPLATE.entry,
    urls: { ...PLUGIN_TEMPLATE.urls },
    parse: { ...PLUGIN_TEMPLATE.parse, title: { attr: 'title' } },
    headers: {},
    imageHosts: [],
  };
}

/* ── 通用设置（key-value） ────────────────────────── */

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const row = await (await db()).get('settings', key);
  return row?.value as T | undefined;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await (await db()).put('settings', { key, value });
}
