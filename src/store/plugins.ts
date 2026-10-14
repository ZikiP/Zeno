import { db, deletePluginData } from './db';
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

  try {
    const endpoint = localStorage.getItem('syncEndpoint') ?? location.origin;
    await fetch(`${endpoint}/api/sync/forget-plugin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  } catch {
    /* 没开同步或连不上，本地已删，够了 */
  }
}

/** 取当前启用的插件；没有就用第一个；一个都没有返回 null（引导用户导入） */
export async function getActivePlugin(): Promise<Plugin | null> {
  const all = await listPlugins();
  if (all.length === 0) return null;

  const activeId = await getSetting<string>('activePluginId');
  if (activeId) {
    const found = all.find((p) => p.plugin.meta.id === activeId);
    if (found) return found.plugin;
  }
  await setSetting('activePluginId', all[0].plugin.meta.id);
  return all[0].plugin;
}

export async function setActivePlugin(id: string): Promise<void> {
  await setSetting('activePluginId', id);
}

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
