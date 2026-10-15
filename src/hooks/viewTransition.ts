import { useCallback, useEffect } from 'react';
import { useNavigate, type NavigateOptions, type To } from 'react-router-dom';
import { flushSync } from 'react-dom';

/**
 * 页面切换动效（原生 View Transitions）
 *
 * 三件事决定了这里长什么样：
 *
 * 1. **转场必须在 DOM 换掉之前发起。** startViewTransition 会先拍旧快照再跑回调，
 *    所以回调里得让 React 同步提交 —— 用 flushSync 包 navigate。
 *    反过来说：等 location 变了再想起来做转场，已经晚了。
 *
 * 2. **`<Link>` 不走 useNavigate。** 与其把每个 Link 换成自定义组件，
 *    不如在 document 的**捕获阶段**拦一次点击：React 的监听器挂在根容器上，
 *    位置比 document 靠下，所以这里 stopPropagation 就能抢在 router 的 onClick 前面。
 *    以后新增 Link 自动就有动效，不用记着换组件。
 *
 * 3. **拦不到的那条路要留着。** 浏览器/系统的返回手势是 popstate，
 *    react-router 自己处理，插不进去。那条路没有 VT，改由挂载动画兜
 *    （见 styles/transition.css 里 html[data-vt-active] 那段）。
 */

type Nav = ReturnType<typeof useNavigate>;
type Dir = 'forward' | 'back';

/** TS 自带 ViewTransition 类型，但运行环境不一定有，所以只能探测不能假定 */
const vtSupported = () => typeof document !== 'undefined' && 'startViewTransition' in document;

/** 方向要在发起前定：快照拍完再改属性就来不及了 */
function markTransition(dir: Dir) {
  const el = document.documentElement;
  el.dataset.vtDir = dir;
  el.dataset.vtActive = '1';
}

function runVt(dir: Dir, commit: () => void) {
  if (!vtSupported()) {
    commit();
    return;
  }
  markTransition(dir);
  const vt = document.startViewTransition(() => flushSync(commit));
  // 转场结束后再摘掉标记，否则新页面的挂载动画会在转场里再演一遍
  void vt.finished.finally(() => {
    delete document.documentElement.dataset.vtActive;
  });
}

/**
 * 替代 useNavigate 的那个版本。
 * `navigate(-1)` 这类数字目标是"回退"，方向要和点链接相反。
 */
export function useVtNavigate() {
  const navigate = useNavigate();
  return useCallback(
    (to: To | number, opts?: NavigateOptions) => {
      const dir: Dir = typeof to === 'number' && to < 0 ? 'back' : 'forward';
      runVt(dir, () => (navigate as Nav)(to as To, opts));
    },
    [navigate],
  );
}

/** 普通左键点同源的站内链接才接管；带修饰键的留给浏览器（新标签页、另存等） */
function clickableAnchor(e: MouseEvent): HTMLAnchorElement | null {
  if (e.defaultPrevented || e.button !== 0) return null;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a) return null;
  if (a.target || a.hasAttribute('download') || a.dataset.noVt !== undefined) return null;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return null;
  if (url.pathname === location.pathname && url.search === location.search) return null;
  return a;
}

/**
 * 挂在 Router 下面、渲染 null 的一个组件：把站内链接的点击接进转场。
 */
export function useVtLinkInterception() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!vtSupported()) return;
    const onClick = (e: MouseEvent) => {
      const a = clickableAnchor(e);
      if (!a) return;
      const url = new URL(a.href, location.href);
      // 先掐掉 react-router 自己的处理，否则它会 push 第二次
      e.preventDefault();
      e.stopPropagation();
      runVt('forward', () => navigate(url.pathname + url.search));
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [navigate]);
}
