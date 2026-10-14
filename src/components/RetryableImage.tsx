/**
 * 图片加载 —— 带重试与断点感知
 *
 * 实测踩过的坑：
 *   1. CDN 偶发断连（UND_ERR_SOCKET），单张图片加载失败整页就花了
 *   2. 离线时图片全挂，页面变成一片空白，用户不知道发生了什么
 *
 * 所以这里做三件事：
 *   - 失败自动重试（指数退避）
 *   - 离线时给出明确提示而不是空白
 *   - 暴露重试入口，让用户能手动再试
 */
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';

/** 图片 URL 已经被代理包过，这里直接用 */
export type ImageState = 'loading' | 'ok' | 'error';

export interface RetryableImageProps {
  src: string;
  alt: string;
  className?: string;
  /** 加载优先级 */
  eager?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
}

const RETRY_DELAYS = [0, 600, 1800];

export function RetryableImage({
  src,
  alt,
  className,
  eager,
  onClick,
  onDoubleClick,
  onContextMenu,
}: RetryableImageProps) {
  const [state, setState] = useState<ImageState>('loading');
  const [attempt, setAttempt] = useState(0);
  const [offline, setOffline] = useState(
    typeof navigator === 'undefined' ? false : !navigator.onLine,
  );

  // 网络恢复时自动重试一次，用户不用手动点
  useEffect(() => {
    const on = () => {
      setOffline(false);
      if (state === 'error') setAttempt((a) => a + 1);
    };
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [state]);

  // 每次 attempt 变化都重新发起加载
  useEffect(() => {
    let cancelled = false;
    setState('loading');

    const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
    const timer = setTimeout(() => {
      if (cancelled) return;
      const img = new Image();
      img.onload = () => !cancelled && setState('ok');
      img.onerror = () => {
        if (cancelled) return;
        // 还有重试次数就继续，否则标记失败
        if (attempt < RETRY_DELAYS.length - 1) setAttempt((a) => a + 1);
        else setState('error');
      };
      img.src = addCacheBuster(src, attempt);
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [src, attempt]);

  if (state === 'error') {
    return (
      <button
        className={`img-fallback${className ? ' ' + className : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setAttempt((a) => a + 1);
        }}
        title="点击重试"
      >
        <span className="img-fallback__icon" />
        <span className="img-fallback__text">
          {offline ? '离线中，无法加载' : '加载失败 · 点此重试'}
        </span>
      </button>
    );
  }

  return (
    <img
      key={attempt}
      className={className}
      src={src}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      style={{ opacity: state === 'ok' ? 1 : 0 }}
      onLoad={() => setState('ok')}
      onError={() => {
        if (attempt < RETRY_DELAYS.length - 1) setAttempt((a) => a + 1);
        else setState('error');
      }}
    />
  );
}

/**
 * 重试时加时间戳绕过缓存。
 * 不加的话失败的 URL 可能被 Cache Storage 记成失败结果，永远重试不出来。
 */
function addCacheBuster(url: string, attempt: number): string {
  if (attempt === 0) return url;
  const sep = url.includes('&') ? '&' : (url.includes('?') ? '&' : '?');
  return `${url}${sep}_r=${Date.now()}_${attempt}`;
}
