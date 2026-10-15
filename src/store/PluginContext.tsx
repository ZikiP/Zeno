import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import {
  browseIdOf,
  enabledIdsOf,
  listPlugins,
  setBrowseId as persistBrowseId,
} from '@/store/plugins';
import { onDataChange } from '@/store/dataEvents';
import type { Plugin } from '@/site/types';

interface PluginCtxValue {
  /**
   * **这一页要用的内容源** —— 不一定等于"发现页在看的源"。
   *
   * 详情页与阅读器把 pluginId 写在路径里，这里就按路径解析。
   * 之前这两个是同一个东西：书架里那本是拷貝漫畫、而激活源是包子漫画时，
   * 点进去会拿包子漫画的规则去拼拷貝漫畫的 slug，结果是「这一章没有图片」。
   */
  plugin: Plugin | null;
  /** 路径点名了一个本机没装的源。要如实说出来，不能拿别的源去解析同一个 slug */
  missingId: string | null;
  /** 已启用的源。发现页的切换器、书架与搜索的范围都以它为准 */
  enabled: Plugin[];
  /** 发现页当前在看哪个源 */
  browseId: string | null;
  setBrowse: (id: string) => void;
  loading: boolean;
  reload: () => Promise<void>;
}

const PluginCtx = createContext<PluginCtxValue>({
  plugin: null,
  missingId: null,
  enabled: [],
  browseId: null,
  setBrowse: () => {},
  loading: true,
  reload: async () => {},
});

const CHANNEL = 'zeno-plugin-change';

/**
 * 从路径里取出"这一页属于哪个内容源"。
 *
 * `/comic/<pluginId>/<slug>`、`/read/<pluginId>/<slug>/<chapterId>` 都带；
 * 发现页、搜索页、书架不绑定某一个源，返回 null 表示"用发现页在看的那个"。
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
  const [enabled, setEnabled] = useState<Plugin[]>([]);
  const [pathPlugin, setPathPlugin] = useState<Plugin | null>(null);
  const [missingId, setMissingId] = useState<string | null>(null);
  const [browseId, setBrowseId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const location = useLocation();

  const pathId = pluginIdFromPath(location.pathname);
  /*
   * reload 要能被广播与数据变更事件调用，又不能因为路径变化就换个函数身份 ——
   * 否则下面那几个订阅全都要跟着重挂。所以路径放在 ref 里读。
   */
  const pathIdRef = useRef(pathId);
  pathIdRef.current = pathId;

  /*
   * 首次读取才算 loading。
   *
   * 换页也会重读（见下面的 pathname 副作用），要是每次都把 loading 拨回 true，
   * RequirePlugin 会在每次导航时闪一下骨架 —— 数据本来就都在本地库里。
   */
  const hasData = useRef(false);

  const reload = useCallback(async () => {
    if (!hasData.current) setLoading(true);
    try {
      const rows = await listPlugins();
      const installed = rows.map((r) => r.plugin);
      const ids = new Set(enabledIdsOf(installed.map((p) => p.meta.id)));
      const on = installed.filter((p) => ids.has(p.meta.id));

      const id = pathIdRef.current;
      const named = id ? installed.find((p) => p.meta.id === id) ?? null : null;
      setEnabled(on);
      setBrowseId(browseIdOf(on.map((p) => p.meta.id)));
      /* 停用的源照样能靠地址打开：停用管的是"还要不要看它的发现页与书架"，
         不是收回访问 —— 已下架的东西点进来该读到，否则书架历史全断。 */
      setPathPlugin(id ? named : null);
      setMissingId(id && !named ? id : null);
      hasData.current = true;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, location.pathname]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = () => void reload();
    return () => ch.close();
  }, [reload]);

  /* 同步可能带来新插件，或改变启用集合。不 reload 的话刚同步完发现页还是空的 */
  useEffect(() => onDataChange(() => void reload()), [reload]);

  const setBrowse = useCallback((id: string) => {
    persistBrowseId(id);
    setBrowseId(id);
  }, []);

  const plugin = useMemo(
    () =>
      pathId
        ? pathPlugin
        : enabled.find((p) => p.meta.id === browseId) ?? null,
    [pathId, pathPlugin, enabled, browseId],
  );

  return (
    <PluginCtx.Provider
      value={{ plugin, missingId, enabled, browseId, setBrowse, loading, reload }}
    >
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
