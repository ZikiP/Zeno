import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import ShelfPage from '@/pages/ShelfPage';
import ExplorePage from '@/pages/ExplorePage';
import ComicPage from '@/pages/ComicPage';
import ReaderPage from '@/pages/ReaderPage';
import { OfflineBar } from '@/components/UI';

/** 在线状态监听 —— 断网时切到离线模式提示 */
function useOnline() {
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
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

export default function App() {
  const online = useOnline();

  return (
    <div className="app">
      <OfflineBar online={online} />
      <Routes>
        <Route path="/" element={<Navigate to="/shelf" replace />} />
        <Route path="/shelf" element={<ShelfPage />} />
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/comic/:slug" element={<ComicPage />} />
        <Route path="/read/:slug/:chapterId" element={<ReaderPage />} />
        <Route path="*" element={<Navigate to="/shelf" replace />} />
      </Routes>
    </div>
  );
}
