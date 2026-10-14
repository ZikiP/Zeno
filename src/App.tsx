import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import ShelfPage from '@/pages/ShelfPage';
import ExplorePage from '@/pages/ExplorePage';
import GlobalSearchPage from '@/pages/GlobalSearchPage';
import ComicPage from '@/pages/ComicPage';
import ReaderPage from '@/pages/reader/ReaderPage';
import SettingsPage from '@/pages/settings/SettingsPage';
import { PluginProvider, usePlugin } from '@/store/PluginContext';
import { OfflineBar } from '@/components/UI';

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

/** 没有已安装的插件时，除设置页外一律拦到设置页 */
function RequirePlugin({ children }: { children: ReactNode }) {
  const { plugin, loading } = usePlugin();
  if (loading) return <div className="loading">加载中</div>;
  if (!plugin) return <Navigate to="/settings" replace />;
  return <>{children}</>;
}

function Shell() {
  const online = useOnline();
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
  return (
    <PluginProvider>
      <Shell />
    </PluginProvider>
  );
}

export { useLocation };
