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

/**
 * 一次解析出来的全部结果，刻意合成**一个**状态。
 *
 * `forPath` 记下这份结果是对哪个地址算的。拆成几个 state 就会在换页那一瞬出现
 * "路径已经是详情页、pathPlugin 还是发现页那份 null"的中间态，RequirePlugin 照着
 * 它判断就把用户弹去设置页了 —— 点封面进不了详情页，真踩过。
 */
interface Resolved {
  enabled: Plugin[];
  /** 地址点名的那个源；没点名时为 null */
  pathPlugin: Plugin | null;
  /** 地址点名了一个本机没装的源 */
  missingId: string | null;
  browseId: string | null;
  forPath: string | null;
}

interface PluginCtxValue {
  /**
   * **这一页要用的内容源** —— 不一定等于"发现页在看的源"。
   *
   * 详情页与阅读器把 pluginId 写在路径里，这里就按路径解析。之前这两个是同一个
   * 东西：书架里那本是拷貝漫畫、而激活源是包子漫画时，点进去会拿包子漫画的规则
   * 去拼拷貝漫畫的 slug，结果是「这一章没有图片」。
   */
  plugin: Plugin | null;
  /** 地址点名了一个本机没装的源。要如实说出来，不能拿别的源去解析同一个 slug */
  missingId: string | null;
  /** 已启用的源。发现页的切换器、书架与搜索的范围都以它为准 */
  enabled: Plugin[];
  /** 发现页当前在看哪个源 */
  browseId: string | null;
  setBrowse: (id: string) => void;
  loading: boolean;
  reload: () => Promise<void>;
}

const EMPTY: Resolved = {
  enabled: [],
  pathPlugin: null,
  missingId: null,
  browseId: null,
  forPath: null,
};

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
  const [data, setData] = useState<Resolved | null>(null);
  const location = useLocation();

  const pathId = pluginIdFromPath(location.pathname);
  /*
   * reload 要能被广播与数据变更事件调用，又不能因为路径变化就换个函数身份 ——
   * 否则下面那几个订阅全都要跟着重挂。所以路径放在 ref 里读。
   */
  const pathIdRef = useRef(pathId);
  pathIdRef.current = pathId;

  const reload = useCallback(async () => {
    const id = pathIdRef.current;
    let next: Resolved;
    try {
      const installed = (await listPlugins()).map((r) => r.plugin);
      const onIds = new Set(enabledIdsOf(installed.map((p) => p.meta.id)));
      const on = installed.filter((p) => onIds.has(p.meta.id));
      const named = id ? installed.find((p) => p.meta.id === id) ?? null : null;
      next = {
        enabled: on,
        /* 停用的源照样能靠地址打开：停用管的是"还要不要看它的发现页与书架"，
           不是收回访问 —— 否则书架上那些历史链接全断。 */
        pathPlugin: id ? named : null,
        missingId: id && !named ? id : null,
        browseId: browseIdOf(on.map((p) => p.meta.id)),
        forPath: id,
      };
    } catch {
      /* 库读不出来（隐私模式、配额）也要落一份，否则界面永远停在骨架上 */
      next = { ...EMPTY, forPath: id };
    }
    setData(next);
  }, []);

  /* 换页重读一次：地址点名的源与启用集合都可能跟着变 */
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
    setData((d) => (d ? { ...d, browseId: id } : d));
  }, []);

  /*
   * 只有"这一页要点名某个源、而手上那份结果不是对它算的"才算没准备好。
   *
   * 发现页、书架、搜索不绑定某一个源，上一份的启用集合照样有效，
   * 没必要为它们闪一次骨架；同一条地址内部换章（/comic/x → /read/x）也不闪。
   */
  const resolved = data ?? EMPTY;
  const loading = data === null || (pathId !== null && resolved.forPath !== pathId);

  const plugin = useMemo(
    () =>
      pathId
        ? resolved.pathPlugin
        : resolved.enabled.find((p) => p.meta.id === resolved.browseId) ?? null,
    [pathId, resolved],
  );

  return (
    <PluginCtx.Provider
      value={{
        plugin,
        missingId: resolved.missingId,
        enabled: resolved.enabled,
        browseId: resolved.browseId,
        setBrowse,
        loading,
        reload,
      }}
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
