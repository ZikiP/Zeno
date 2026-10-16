/**
 * 全屏（沉浸式阅读）
 *
 * 只回答三件事：这台设备撑不撑得起、现在是不是全屏、切一次。
 *
 * iPhone 的 Safari 没有元素级 Fullscreen API（只有 <video> 能全屏），
 * 所以在 iPhone 上这颗按钮点了不会有任何反应 —— 与其摆一个死按钮，
 * 不如干脆不画（fullscreenSupported() 为 false），并在设置里写清楚
 * 走「添加到主屏幕」拿同等效果（manifest 已是 display: standalone）。
 */

type FsHost = HTMLElement & {
  webkitRequestFullscreen?: (opts?: unknown) => Promise<void> | void;
};
type FsDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

export function fullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.documentElement as FsHost | null;
  if (!el) return false;
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
}

export function isFullscreen(): boolean {
  if (typeof document === 'undefined') return false;
  return !!(document.fullscreenElement || (document as FsDoc).webkitFullscreenElement);
}

/** 切一次，返回切完之后的真实状态（不猜 —— 浏览器可以直接拒绝） */
export async function toggleFullscreen(): Promise<boolean> {
  const doc = document as FsDoc;
  try {
    if (isFullscreen()) {
      const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(doc);
      await exit?.();
    } else {
      const el = document.documentElement as FsHost;
      const enter = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
      await enter?.({ navigationUI: 'hide' });
    }
  } catch {
    /* 用户手势之外调用、或站点被策略挡住。下面的真实状态会给出答案 */
  }
  return isFullscreen();
}

/** 系统手势（安卓下滑、ESC）退出全屏时界面要跟着变，所以不能只在点击回调里读状态 */
export function onFullscreenChange(cb: () => void): () => void {
  const events = ['fullscreenchange', 'webkitfullscreenchange'];
  for (const e of events) document.addEventListener(e, cb);
  return () => {
    for (const e of events) document.removeEventListener(e, cb);
  };
}
