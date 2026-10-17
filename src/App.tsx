import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useParams, useSearchParams, useLocation } from 'react-router-dom';
import ShelfPage from '@/pages/ShelfPage';
import ExplorePage from '@/pages/ExplorePage';
import GlobalSearchPage from '@/pages/GlobalSearchPage';
import ComicPage from '@/pages/ComicPage';
import ReaderPage from '@/pages/reader/ReaderPage';
import SettingsPage from '@/pages/settings/SettingsPage';
import { PluginProvider, usePlugin } from '@/store/PluginContext';
import { useTheme } from '@/hooks/useTheme';
import { useUiFont } from '@/fonts/useUiFont';
import { Loading, OfflineBar } from '@/components/UI';
import { IconEmpty } from '@/components/Icons';
import SyncPill from '@/sync/SyncPill';
import BottomNav from '@/components/BottomNav';
import { sync } from '@/sync/client';

function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/**
 * 首轮同步有没有出结果（最多等 4 秒）。
 *
 * RequirePlugin 用它避开冷启动竞态：插件还在同步路上时，
 * 「本地没有插件」是个假结论，照它把用户弹到设置页，
 * 插件到了人也回不去发现页了。
 *
 * 4 秒是硬上限 —— 服务端在 tailnet 外面时不该让人干等一个连不上的请求。
 */
function useFirstSyncSettled(): boolean {
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => alive && setSettled(true), 4000);
    void sync.whenSettled().then(() => {
      if (!alive) return;
      clearTimeout(timer);
      setSettled(true);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  return settled;
}

/**
 * 内容源齐不齐。
 *
 * 两种缺法要分开：路径里点名了一个本机没装的源（别人的分享链接、书架里那本
 * 换了设备）—— 这种**不能**把用户弹到设置页了事，他会不知道为什么，而且
 * 地址栏里那本书还在，装了源就该回得来。
 *
 * 一个源都没有时也不弹走：弹到设置页等于把用户刚才那一下（点封面、点开书架里
 * 的书）整个吞掉，而且首轮同步晚一步落库时，"本地没有源"是个假结论 ——
 * 插件到了人却留在设置页。就地说明 + 给个入口，数据一到这一页自己就活了。
 */
function RequirePlugin({ children }: { children: ReactNode }) {
  const { plugin, missingId, loading } = usePlugin();
  const synced = useFirstSyncSettled();
  if (loading || !synced) return <Loading />;
  if (missingId) return <MissingSource id={missingId} />;
  if (!plugin) return <NoSource />;
  return <>{children}</>;
}

function NoSource() {
  return (
    <main className="main">
      <div className="empty">
        <IconEmpty size={40} />
        <div>还没有启用任何内容源</div>
        <div style={{ fontSize: 12 }}>
          Zeno 不内置内容，装一个插件 JSON 并打开它的开关就能用；
          全都停用了也只要再打开一个。
        </div>
        <Link className="btn" to="/settings?tab=sources">
          去内容源
        </Link>
      </div>
    </main>
  );
}

function MissingSource({ id }: { id: string }) {
  return (
    <main className="main">
      <div className="missing-source">
        <h2>这台设备上没有「{id}」这个内容源</h2>
        <p>
          这个地址里的漫画属于一个没装过的来源。同一串 slug 在不同站上指向完全不同的作品，
          所以 Zeno 不会拿别的源去凑 —— 装好那个源再回来，这个地址就能打开。
        </p>
        <Link className="btn" to="/settings?tab=sources">
          去内容源里导入
        </Link>
      </div>
    </main>
  );
}

/**
 * 主题应用器
 *
 * 放在 App 层而不是设置页：主题是全局状态，
 * 同步把别处的主题拉回来时，**任何页面**都该立刻生效，
 * 不管用户当前停在哪个路由。
 *
 * 注意这里渲染一个空 div 而不是 null —— React 对返回 null 的组件
 * 虽然仍会执行 hook，但显式渲染一个元素能避免任何优化路径的歧义。
 */
function ThemeApplier() {
  const { mode } = useTheme();
  void mode;
  useUiFont();
  return <span hidden data-theme-applier />;
}

function Shell() {
  const online = useOnline();
  const { pathname } = useLocation();
  return (
    <div className="app">
      <OfflineBar online={online} />
      <Routes>
        <Route path="/" element={<Navigate to="/shelf" replace />} />
        <Route path="/shelf" element={<ShelfPage />} />
        <Route
          path="/explore"
          element={
            <RequirePlugin>
              <ExplorePage />
            </RequirePlugin>
          }
        />
        <Route
          path="/search"
          element={
            <RequirePlugin>
              <GlobalSearchPage />
            </RequirePlugin>
          }
        />
        <Route
          path="/comic/:pluginId/:slug"
          element={
            <RequirePlugin>
              <ComicPage />
            </RequirePlugin>
          }
        />
        <Route
          path="/read/:pluginId/:slug/:chapterId"
          element={
            <RequirePlugin>
              <ReaderRoute />
            </RequirePlugin>
          }
        />
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="*" element={<Navigate to="/shelf" replace />} />
      </Routes>
      {/* 顶栏右端那颗同步泡，逻辑见 SyncPill：它自己找到当前这一页的顶栏挂进去 */}
      <SyncPill />
      {NAV_ROUTES.has(pathname) && <BottomNav />}
    </div>
  );
}

/**
 * 底栏挂在 Shell 而不是各页面里 —— 切 tab 时它必须保持同一个实例。
 *
 * UseAnimations 的 click-toggle 在挂载时就已经是选中态的话，会直接跳到终帧不播
 * （见其源码里 atEnd + goToAndStop）。之前四个页面各挂一份，切页等于重挂，
 * 图标就只是「已经变成那个样子」，看不到形变。
 */
const NAV_ROUTES = new Set(['/shelf', '/explore', '/search', '/settings']);

/**
 * 阅读器路由。
 * slug 与插件 id 都在路径里 —— 这样刷新页面、分享链接都能还原，
 * 不会因为路由 state 丢失而白屏。
 */
function ReaderRoute() {
  const { slug = '', chapterId = '' } = useParams();
  return <ReaderPage slug={slug} chapterId={chapterId} />;
}

/** 设置页当前哪一栏写在地址里，换栏就是替换查询参数 —— 返回键因此还能用 */
function SettingsRoute() {
  const [params, setParams] = useSearchParams();
  return (
    <SettingsPage
      tab={params.get('tab')}
      onTabChange={(key) => {
        const next = new URLSearchParams(params);
        next.set('tab', key);
        setParams(next, { replace: true });
      }}
    />
  );
}

export default function App() {
  /*
   * 启动自动同步。
   * 未配置服务端地址时 sync.start() 内部会直接返回，不做任何请求，
   * 所以纯本地用户不受影响。
   */
  useEffect(() => {
    sync.start();
    return () => sync.stop();
  }, []);

  return (
    <PluginProvider>
      <ThemeApplier />
      <Shell />
    </PluginProvider>
  );
}
