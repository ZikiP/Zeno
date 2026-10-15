import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import ShelfPage from '@/pages/ShelfPage';
import ExplorePage from '@/pages/ExplorePage';
import GlobalSearchPage from '@/pages/GlobalSearchPage';
import ComicPage from '@/pages/ComicPage';
import ReaderPage from '@/pages/reader/ReaderPage';
import SettingsPage from '@/pages/settings/SettingsPage';
import { PluginProvider, usePlugin } from '@/store/PluginContext';
import { useTheme } from '@/hooks/useTheme';
import { useVtLinkInterception } from '@/hooks/viewTransition';
import { OfflineBar } from '@/components/UI';
import SyncBar from '@/sync/SyncUI';
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

/** 没有已安装的插件时，除设置页外一律拦到设置页 */
function RequirePlugin({ children }: { children: ReactNode }) {
  const { plugin, loading } = usePlugin();
  const synced = useFirstSyncSettled();
  if (loading || !synced) return <div className="loading">加载中</div>;
  if (!plugin) return <Navigate to="/settings" replace />;
  return <>{children}</>;
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
  return <span hidden data-theme-applier />;
}

function Shell() {
  const online = useOnline();
  return (
    <div className="app">
      <OfflineBar online={online} />
      <SyncBar />
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
          path="/comic/:slug"
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
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/shelf" replace />} />
      </Routes>
    </div>
  );
}

/**
 * 阅读器路由。
 * slug 与插件 id 都在路径里 —— 这样刷新页面、分享链接都能还原，
 * 不会因为路由 state 丢失而白屏。
 */
function ReaderRoute() {
  const { slug = '', chapterId = '' } = useParams();
  return <ReaderPage slug={slug} chapterId={chapterId} />;
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

  // 站内链接的点击接进 View Transition（不支持的浏览器里这是个空操作）
  useVtLinkInterception();

  return (
    <PluginProvider>
      <ThemeApplier />
      <Shell />
    </PluginProvider>
  );
}
