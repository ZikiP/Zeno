import { useEffect, useState } from 'react';

/** 这一页此刻处于哪个阶段 */
export type PagePhase = 'ok' | 'load' | 'enhance' | 'error';

/** 晚这么久才出现：正常命中缓存的一页几十毫秒就画出来了，别闪一下提示 */
const SHOW_AFTER_MS = 300;

/**
 * 黑页上的状态条：告诉用户是在拉图片还是在算增强，并给一颗手动刷新。
 *
 * 两种阅读方式都挂在整屏上（fixed），不塞在页里面：
 *   - 分页：点击区盖在图片上面（z-index 5），页里的按钮收不到点击。
 *   - 滚动：图片还没到时 <img> 高度是 0，页内提示会跟着塌成 0 高、被顶栏压住。
 */
export default function PageStatus({
  phase,
  onRetry,
}: {
  phase: PagePhase;
  onRetry: () => void;
}) {
  const active = phase === 'load' || phase === 'enhance';
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!active) {
      setShow(false);
      return;
    }
    /* 已经露出来了就不要再等一轮 —— 从「拉取」切到「增强」时提示会闪掉一下 */
    if (show) return;
    const timer = window.setTimeout(() => setShow(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [active, show]);

  if (!active || !show) return null;

  return (
    <div className="page-status" role="status" aria-live="polite">
      <span className="spinner page-status__spinner" />
      <span>{phase === 'enhance' ? '画面增强中…' : '正在拉取图片…'}</span>
      <button
        className="page-status__retry"
        onClick={(e) => {
          /* 按钮点在点击区/图片上：别顺手翻一页或者开关菜单 */
          e.stopPropagation();
          onRetry();
        }}
      >
        刷新
      </button>
    </div>
  );
}
