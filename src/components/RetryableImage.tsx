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

/*
 * 已经确认能直接画出来的地址。
 *
 * 为什么需要它：state 从 'loading' 起步意味着每次挂载都有一张透明图，
 * 翻页时"被露出来的那一页"第一帧是黑的 —— 那就是翻页闪一下的根因。
 * 图片其实早就在缓存里了，只是 React 不知道。
 *
 * 记在这里而不是问 <img>.complete：那要等元素挂上，第一帧已经画完了。
 */
const readySrcs = new Set<string>();

/** 一张确认能画了：记下来，并告诉订阅者（自动下一章等的就是这个信号） */
function markReady(src: string) {
  if (readySrcs.has(src)) return;
  readySrcs.add(src);
  for (const w of watchers) w();
}

/** 预加载成功时调它，翻页时那一页就能直接以不透明状态出现 */
export function markImageReady(src: string) {
  markReady(src);
}

/**
 * 取不到的地址。和 readySrcs 一样是进程级的：
 * 只有这张图自己知道它失败了几次，而调用方（阅读器）想知道的是
 * "这一章到底坏了多少张" —— 逐个传回调要把 props 穿过五层视图组件，
 * 换到的东西跟记在这儿是一样的。
 */
const failedSrcs = new Set<string>();
const watchers = new Set<() => void>();

function noteFailed(src: string, failed: boolean) {
  const had = failedSrcs.has(src);
  if (failed === had) return;
  if (failed) failedSrcs.add(src);
  else failedSrcs.delete(src);
  for (const w of watchers) w();
}

/**
 * 订阅"图片状态变了"（成功、失败都算）。
 *
 * 两件事要靠它：数出一章里挂了多少张（useImageHealth），
 * 以及"最后一张终于落地了"（自动下一章 —— 滚到底那一刻最后一张还在路上，
 * 当时跳就会把这一章的尾巴翻过去）。
 */
export function onImageStateChange(watch: () => void) {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

/** 这批地址里现在取不到的是几张 */
export function failedCountAmong(srcs: readonly string[]) {
  let n = 0;
  for (const s of srcs) if (failedSrcs.has(s)) n++;
  return n;
}

export function isImageReady(src: string) {
  return readySrcs.has(src);
}

export function RetryableImage({
  src,
  alt,
  className,
  eager,
  onClick,
  onDoubleClick,
  onContextMenu,
}: RetryableImageProps) {
  const [state, setState] = useState<ImageState>(() =>
    readySrcs.has(src) ? 'ok' : 'loading',
  );
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
    setState(readySrcs.has(src) ? 'ok' : 'loading');

    const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
    const timer = setTimeout(() => {
      if (cancelled) return;
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        markReady(src);
        noteFailed(src, false);
        setState('ok');
      };
      img.onerror = () => {
        if (cancelled) return;
        // 还有重试次数就继续，否则标记失败
        if (attempt < RETRY_DELAYS.length - 1) setAttempt((a) => a + 1);
        else {
          noteFailed(src, true);
          setState('error');
        }
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
      onLoad={() => {
        markReady(src);
        noteFailed(src, false);
        setState('ok');
      }}
      onError={() => {
        if (attempt < RETRY_DELAYS.length - 1) setAttempt((a) => a + 1);
        else {
          noteFailed(src, true);
          setState('error');
        }
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
