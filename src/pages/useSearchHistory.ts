import { useCallback, useEffect, useRef, useState } from 'react';

const KEY = 'globalSearchRecent';
const MAX = 8;

/**
 * 跨源搜索的「最近搜过」
 *
 * 从 GlobalSearchPage 抽出来。这里有个踩过的坑，别在改回去：
 * 记录历史要读旧列表，但旧列表**不能进 search 回调的依赖** ——
 * setRecent 改值 → search 变成新函数 → 触发搜索的 effect 重跑 → 又 setRecent，
 * 无限循环把请求打满（实测刷出 180+ 个报错）。
 * 所以值给界面用、ref 给回调读，两份并存。
 */
export function useSearchHistory() {
  const [recent, setRecent] = useState<string[]>([]);
  const ref = useRef<string[]>([]);

  useEffect(() => {
    let stored: string[] = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
      if (Array.isArray(parsed)) stored = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      stored = [];
    }
    ref.current = stored;
    setRecent(stored);
  }, []);

  /** 记一次成功搜索：同词提到最前，超出上限从尾部丢 */
  const record = useCallback((term: string) => {
    const next = [term, ...ref.current.filter((r) => r !== term)].slice(0, MAX);
    ref.current = next;
    setRecent(next);
    localStorage.setItem(KEY, JSON.stringify(next));
  }, []);

  const clear = useCallback(() => {
    ref.current = [];
    setRecent([]);
    localStorage.removeItem(KEY);
  }, []);

  return { recent, record, clear };
}
