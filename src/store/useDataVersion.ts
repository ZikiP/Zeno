import { useCallback, useEffect, useState } from 'react';
import { onDataChange } from './dataEvents';

/**
 * 订阅本地数据变更，返回一个自增的版本号。
 *
 * 页面这样用：
 *   const v = useDataVersion();
 *   useEffect(() => { load(); }, [v]);
 *
 * 同步写完 IndexedDB 后会 emitDataChange()，v 自增，页面自动重读。
 * 这样不用给每个页面塞 Provider，也不手动刷新路由。
 */
export function useDataVersion(): number {
  const [v, setV] = useState(0);

  useEffect(() => {
    return onDataChange(() => setV((n) => n + 1));
  }, []);

  return v;
}

/**
 * 数据版本变化时重新执行 loader。
 * 这是最常用的形态，省掉手写 useEffect 依赖。
 */
export function useReloadOnChange(loader: () => void | Promise<void>): void {
  const v = useDataVersion();
  const run = useCallback(loader, [loader]);

  useEffect(() => {
    void run();
    // 首次挂载与每次数据变更都跑
  }, [v, run]);
}
