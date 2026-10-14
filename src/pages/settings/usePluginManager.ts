import { useCallback, useState } from 'react';
import {
  deletePlugin,
  getActivePlugin,
  listPlugins,
  newPluginTemplate,
  savePlugin,
  setActivePlugin,
} from '@/store/plugins';
import type { InstalledPlugin } from '@/store/db';
import { notifyPluginChanged } from '@/store/PluginContext';
import { validatePlugin, type Plugin } from '@/site/types';

/**
 * 插件的增删改查与导入导出
 *
 * 从 SettingsPage 抽出来 —— 那个文件本来就有 578 行，
 * 插件管理是其中自成一块的逻辑，抽走后页面只剩布局。
 */
export interface PluginManager {
  plugins: InstalledPlugin[] | null;
  activeId: string | null;
  /** 正在编辑的插件（弹窗里） */
  editing: Plugin | null;
  /** 导入/保存后的提示 */
  message: { kind: 'ok' | 'err'; text: string } | null;
  reload: () => Promise<void>;
  startCreate: () => void;
  startEdit: (p: Plugin) => void;
  closeEditor: () => void;
  switchTo: (id: string) => Promise<void>;
  remove: (p: Plugin) => Promise<void>;
  importFile: (file: File) => Promise<void>;
  exportPlugin: (p: Plugin) => void;
  /** 编辑器保存成功后的收尾 */
  finishSave: (name: string) => Promise<void>;
}

export function usePluginManager(): PluginManager {
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Plugin | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const reload = useCallback(async () => {
    const [all, active] = await Promise.all([listPlugins(), getActivePlugin()]);
    setPlugins(all);
    setActiveId(active?.meta.id ?? null);
  }, []);

  const switchTo = useCallback(
    async (id: string) => {
      await setActivePlugin(id);
      await reload();
      notifyPluginChanged();
    },
    [reload],
  );

  const remove = useCallback(
    async (p: Plugin) => {
      if (!confirm(`删除插件「${p.meta.name}」？\n该插件的书架与离线缓存会一并清除。`)) return;
      await deletePlugin(p.meta.id);
      await reload();
      notifyPluginChanged();
      setMessage({ kind: 'ok', text: `已删除插件「${p.meta.name}」` });
    },
    [reload],
  );

  const importFile = useCallback(
    async (file: File) => {
      setMessage(null);

      let json: unknown;
      try {
        json = JSON.parse(await file.text());
      } catch {
        setMessage({ kind: 'err', text: '文件不是合法 JSON' });
        return;
      }

      /*
       * 校验不能省 —— 别人分享来的插件可能是任意内容。
       * 格式不对直接导入，轻则解析失败，重则渲染出错。
       */
      const errs = validatePlugin(json);
      if (errs.length > 0) {
        setMessage({ kind: 'err', text: `插件校验未通过：\n· ${errs.join('\n· ')}` });
        return;
      }

      const p = json as Plugin;
      const exists = plugins?.some((i) => i.plugin.meta.id === p.meta.id);

      await savePlugin({ plugin: p, installedAt: Date.now(), origin: 'imported' });
      await switchTo(p.meta.id);

      setMessage({
        kind: 'ok',
        text: exists
          ? `已更新插件「${p.meta.name}」并设为当前`
          : `已导入插件「${p.meta.name}」并设为当前`,
      });
    },
    [plugins, switchTo],
  );

  const exportPlugin = useCallback((p: Plugin) => {
    const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    /*
     * 文件名要过滤非法字符。插件 id 由使用者填写，可能含 / \ : * ? " < > |，
     * 这些在 Windows 上会导致保存失败。
     */
    const safeId = p.meta.id.replace(/[\\/:*?"<>|\s-]/g, '_').slice(0, 60);
    a.download = `zeno-plugin-${safeId || 'unnamed'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const finishSave = useCallback(
    async (name: string) => {
      setEditing(null);
      await reload();
      notifyPluginChanged();
      setMessage({ kind: 'ok', text: `插件「${name}」已保存并设为当前` });
    },
    [reload],
  );

  return {
    plugins,
    activeId,
    editing,
    message,
    reload,
    startCreate: () => setEditing(newPluginTemplate('新建插件')),
    startEdit: (p) => setEditing(p),
    closeEditor: () => setEditing(null),
    switchTo,
    remove,
    importFile,
    exportPlugin,
    finishSave,
  };
}
