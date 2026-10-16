import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * 返回：应用历史里有上一页就退回去，没有就回书架。
 *
 * react-router 把栈下标写在 history.state.idx 上，直接敲 URL 进来时是 0。
 * 这时 nav(-1) 会跳出站点，浏览器给一张空白历史页。
 */
export function useBackToHome() {
  const nav = useNavigate();

  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) nav(-1);
    else nav('/shelf', { replace: true });
  }, [nav]);
}
