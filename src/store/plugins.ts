import { db, deletePluginData } from './db';
import { recordDelete } from './tombstones';
import { PLUGIN_FORMAT, PLUGIN_TEMPLATE, type Plugin } from '@/site/types';
import type { InstalledPlugin } from './db';
import { serverNow } from '@/sync/clock';

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
    updatedAt: serverNow(),
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

/* ── 启用 / 停用 ────────────────────────────────── */

/**
 * 启用集合。逗号拼接存在 localStorage —— 因为它在 SYNCED_KEYS 里，
 * 而 collectSettings() 读的就是 localStorage；存成数组会变成 IndexedDB
 * 那一份、两边不一致，结果这个键被声明为同步项却永远同步不出去。
 * `__at` 后缀是同步层给每个键记的写入时间，LWW 要用它。
 */
const ENABLED_KEY = 'enabledPluginIds';
/** 发现页当前在看哪个源。每台设备自己的浏览位置，刻意**不**同步 */
const BROWSE_KEY = 'browsePluginId';

/**
 * 已装插件里哪些算启用。
 *
 * 没写过这个键时**全部已装的都算启用**。老设备升级上来也是这个结果：
 * 以前书架按"当前那一个源"过滤，看着像是只启用了那一个，其实只是没别的选择 ——
 * 照 activePluginId 只启用一个，升级那一刻书架上别的产品源的书会凭空消失，
 * 用户只会以为功能坏了。装了几个源就是想看几个源。
 *
 * 允许返回空数组 —— 用户可以把所有源都停掉，那时候界面上就该是空的。
 */
export function enabledIdsOf(installedIds: string[]): string[] {
  const raw = localStorage.getItem(ENABLED_KEY);
  if (raw === null) return [...installedIds];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && installedIds.includes(s));
}

export function setEnabledIds(ids: string[]): void {
  localStorage.setItem(ENABLED_KEY, ids.join(','));
  localStorage.setItem(`${ENABLED_KEY}__at`, String(serverNow()));
}

/** 改一个源的启用状态，返回改完的启用集合 */
export function setPluginEnabled(id: string, on: boolean, installedIds: string[]): string[] {
  const now = new Set(enabledIdsOf(installedIds));
  if (on) now.add(id);
  else now.delete(id);
  // 保持安装顺序，不然开关点一下列表就跳序
  const next = installedIds.filter((i) => now.has(i));
  setEnabledIds(next);
  return next;
}

/**
 * 就一个源改启用状态，已装列表自己读。
 *
 * 调用方手上常常只有刚保存的插件（导入、编辑器保存），那份列表还是旧的 ——
 * 让调用方传就会把新插件过滤掉，开关点了没生效。
 */
export async function togglePluginEnabled(id: string, on: boolean): Promise<string[]> {
  const all = (await listPlugins()).map((p) => p.plugin.meta.id);
  return setPluginEnabled(id, on, all);
}

/**
 * 发现页在看的那个源。
 *
 * 上次看的源被停用了就退到启用集合的第一个 —— 宁可换个源显示，
 * 也不要停在一个"这个源没启用"的死页上。
 */
export function browseIdOf(enabledIds: string[]): string | null {
  const saved = localStorage.getItem(BROWSE_KEY);
  if (saved && enabledIds.includes(saved)) return saved;
  return enabledIds[0] ?? null;
}

export function setBrowseId(id: string): void {
  localStorage.setItem(BROWSE_KEY, id);
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
