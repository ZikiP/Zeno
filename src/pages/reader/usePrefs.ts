import { useCallback, useState } from 'react';
import { loadPrefs, savePrefs, type ReaderPrefs } from '@/reader/prefs';

/**
 * 阅读偏好
 *
 * 抽出来是因为它有"写回 localStorage"这个副作用，
 * 混在页面里会让页面每次渲染都带着一个同步的存储操作。
 */
export function usePrefs(defaults: ReaderPrefs) {
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadPrefs() ?? defaults);

  const patch = useCallback((delta: Partial<ReaderPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...delta };
      savePrefs(next);
      return next;
    });
  }, []);

  return { value: prefs, patch };
}
