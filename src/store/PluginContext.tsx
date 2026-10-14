import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import { getActivePlugin } from '@/store/plugins';
import { onDataChange } from '@/store/dataEvents';
import type { Plugin } from '@/site/types';

interface PluginCtxValue {
  plugin: Plugin | null;
  loading: boolean;
  reload: () => Promise<void>;
}

const PluginCtx = createContext<PluginCtxValue>({
  plugin: null,
  loading: true,
  reload: async () => {},
});

const CHANNEL = 'zeno-plugin-change';

export function PluginProvider({ children }: { children: ReactNode }) {
  const [plugin, setPlugin] = useState<Plugin | null>(null);
  const [loading, setLoading] = useState(true);
  const location = useLocation();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setPlugin(await getActivePlugin());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /*
   * 切换/删除插件后要刷新上下文，否则：
   *   - 在设置页切了插件，返回发现页还在用旧的
   *   - 删掉了当前插件，页面还拿着已删除的配置在跑
   *
   * 两个触发点：从设置页离开时、收到其他标签页的通知时。
   */
  useEffect(() => {
    if (location.pathname === '/settings') void reload();
  }, [location.pathname, reload]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = () => void reload();
    return () => ch.close();
  }, [reload]);

  /* 同步可能带来新插件，或改变「当前插件」。不 reload 的话刚同步完发现页还是空的 */
  useEffect(() => onDataChange(() => void reload()), [reload]);

  return (
    <PluginCtx.Provider value={{ plugin, loading, reload }}>{children}</PluginCtx.Provider>
  );
}

export const usePlugin = () => useContext(PluginCtx);

/**
 * 通知其它标签页：插件变了
 *
 * 和 dataEvents 同样的问题 —— BroadcastChannel 不向发送方投递，
 * 但这里发送方通常自己会 setState，所以影响小。不过为一致性两条通道都发。
 */
export function notifyPluginChanged() {
  window.dispatchEvent(new CustomEvent(CHANNEL));
  if (typeof BroadcastChannel === 'undefined') return;
  const ch = new BroadcastChannel(CHANNEL);
  ch.postMessage('changed');
  ch.close();
}
