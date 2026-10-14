import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import ShelfPage from '@/pages/ShelfPage';
import ExplorePage from '@/pages/ExplorePage';
import ComicPage from '@/pages/ComicPage';
import ReaderPage from '@/pages/ReaderPage';
import SettingsPage from '@/pages/SettingsPage';
import { SiteProvider, useSite } from '@/store/SiteContext';
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

/** 没有配置站点时，除设置页外一律拦到设置页 */
function RequireSite({ children }: { children: ReactNode }) {
  const { site, loading } = useSite();
  if (loading) return <div className="loading">加载中</div>;
  if (!site) return <Navigate to="/settings" replace />;
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
            <RequireSite>
              <ExplorePage />
            </RequireSite>
          }
        />
        <Route
          path="/comic/:slug"
          element={
            <RequireSite>
              <ComicPage />
            </RequireSite>
          }
        />
        <Route
          path="/read/:slug/:chapterId"
          element={
            <RequireSite>
              <ReaderRoute />
            </RequireSite>
          }
        />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/shelf" replace />} />
      </Routes>
    </div>
  );
}

/** slug 由路由提供，chapterId 也是；这里只做参数透传 */
function ReaderRoute() {
  const { slug = '', chapterId = '' } = useParams();
  return <ReaderPage slug={slug} chapterId={chapterId} />;
}

export default function App() {
  return (
    <SiteProvider>
      <Shell />
    </SiteProvider>
  );
}

export { useLocation };
