import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import { getActivePlugin, getPlugin } from '@/store/plugins';
import { onDataChange } from '@/store/dataEvents';
import type { Plugin } from '@/site/types';

interface PluginCtxValue {
  /**
   * **这一页要用的内容源** —— 不一定等于"当前激活的源"。
   *
   * 详情页与阅读器把 pluginId 写在路径里，这里就按路径解析。
   * 之前这两个是同一个东西：书架里那本是拷貝漫畫、而激活源是包子漫画时，
   * 点进去会拿包子漫画的规则去拼拷貝漫畫的 slug，结果是「这一章没有图片」，
   * 全局搜索因此还得先偷偷切一次源再跳（副作用是用户回不来原来的源了）。
   */
  plugin: Plugin | null;
  /** 路径点名了一个本机没装的源。要如实说出来，不能拿别的源去解析同一个 slug */
  missingId: string | null;
  loading: boolean;
  /** 当前激活的源（发现页、搜索页用），与路径无关 */
  active: Plugin | null;
  reload: () => Promise<void>;
}

const PluginCtx = createContext<PluginCtxValue>({
  plugin: null,
  missingId: null,
  loading: true,
  active: null,
  reload: async () => {},
});

const CHANNEL = 'zeno-plugin-change';

/**
 * 从路径里取出"这一页属于哪个内容源"。
 *
 * `/comic/<pluginId>/<slug>`、`/read/<pluginId>/<slug>/<chapterId>` 都带；
 * 发现页、搜索页、书架不绑定某一个源，返回 null 表示"用激活的那个"。
 */
export function pluginIdFromPath(pathname: string): string | null {
  const seg = pathname.split('/').filter(Boolean);
  if ((seg[0] === 'comic' || seg[0] === 'read') && seg.length >= 2) {
    try {
      return decodeURIComponent(seg[1]);
    } catch {
      return seg[1];
    }
  }
  return null;
}

export function PluginProvider({ children }: { children: ReactNode }) {
  const [plugin, setPlugin] = useState<Plugin | null>(null);
  const [active, setActive] = useState<Plugin | null>(null);
  const [missingId, setMissingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const location = useLocation();

  const pathId = pluginIdFromPath(location.pathname);
  /*
   * reload 要能被广播与数据变更事件调用，又不能因为路径变化就换个函数身份 ——
   * 否则下面那几个订阅全都要跟着重挂。所以路径放在 ref 里读。
   */
  const pathIdRef = useRef(pathId);
  pathIdRef.current = pathId;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const found = await getActivePlugin();
      setActive(found);
      const id = pathIdRef.current;
      if (id) {
        const row = await getPlugin(id);
        setPlugin(row ? row.plugin : null);
        setMissingId(row ? null : id);
      } else {
        setPlugin(found);
        setMissingId(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, pathId]);

  /*
   * 切换/删除插件后要刷新上下文，否则：
   *   - 在设置页切了插件，返回发现页还在用旧的
   *   - 删掉了当前插件，页面还拿着已删除的配置在跑
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
    <PluginCtx.Provider value={{ plugin, missingId, active, loading, reload }}>
      {children}
    </PluginCtx.Provider>
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
