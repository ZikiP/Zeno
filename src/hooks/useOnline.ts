import { useEffect, useState } from 'react';

/**
 * 浏览器在线状态。
 *
 * 阅读器顶栏之前用「章节表命中 IndexedDB」当成离线：
 * 只要这章以前打开过就显示「离线」，哪怕网络一切正常。
 * 真正的离线判断只该来自 navigator.onLine 和 online/offline 事件。
 */
export function useOnline(): boolean {
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
