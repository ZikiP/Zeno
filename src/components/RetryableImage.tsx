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
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';

/** 图片 URL 已经被代理包过，这里直接用 */
export type ImageState = 'loading' | 'ok' | 'error';

export interface RetryableImageProps {
  src: string;
  alt: string;
  className?: string;
  /** 加载优先级 */
  eager?: boolean;
  /** 浏览器请求优先级：当前屏 high，预热/下一章 low */
  fetchPriority?: 'high' | 'low' | 'auto';
  /** 要拿到那个 <img> 元素本身的调用方用（画面增强要量它的显示宽度、要盯它进不进视野） */
  imgRef?: RefObject<HTMLImageElement>;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
  /**
   * 这个地址彻底拿不到时告诉调用方一声。
   * 只给 blob:/data: 这类"本机现造的地址"用：它们失败不是网络问题，
   * 重试三次也不会变成能加载，该让出地方换回原图。
   */
  onSourceFailed?: () => void;
  /**
   * 强制先不画：内容为「还没到」而不是「坏了」。
   * 画面增强用它 —— 增强版没就绪时宁可留一张空的（阅读器底色就是黑的，
   * 看着和这一页还在加载一样），也不要先画原图再半秒后硬换成增强版。
   */
  hidden?: boolean;
  /** 把当前状态报给调用方：阅读器要按「拉取 / 增强」分别提示 */
  onStateChange?: (state: ImageState) => void;
  /** 变一次从头再来一次（手动刷新用）。地址会带上绕缓存参数 */
  reloadToken?: number;
}

const RETRY_DELAYS = [0, 600, 1800];

/**
 * 本机现造的地址（增强图、内联图）。它失败说明地址本身没了，
 * 重试和绕缓存都救不回来 —— 该退回原图，而不是摆一颗「点此重试」。
 */
const isLocalSrc = (src: string) => src.startsWith('blob:') || src.startsWith('data:');

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
  fetchPriority,
  imgRef,
  onClick,
  onDoubleClick,
  onContextMenu,
  onSourceFailed,
  hidden,
  onStateChange,
  reloadToken = 0,
}: RetryableImageProps) {
  const [state, setState] = useState<ImageState>(() =>
    readySrcs.has(src) ? 'ok' : 'loading',
  );
  const [attempt, setAttempt] = useState(0);
  const [offline, setOffline] = useState(
    typeof navigator === 'undefined' ? false : !navigator.onLine,
  );

  useEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);

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
        /* 本机造的地址不重试：重试只会把一个能看的页面拖成三连败 + 一颗「点此重试」 */
        if (isLocalSrc(src)) {
          onSourceFailed?.();
          return;
        }
        // 还有重试次数就继续，否则标记失败
        if (attempt < RETRY_DELAYS.length - 1) setAttempt((a) => a + 1);
        else {
          noteFailed(src, true);
          setState('error');
        }
      };
      img.src = addCacheBuster(src, attempt + reloadToken);
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [src, attempt, reloadToken]);

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
      key={`${attempt}:${reloadToken}`}
      ref={imgRef}
      className={className}
      src={src}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      fetchPriority={fetchPriority}
      decoding="async"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      style={{ opacity: !hidden && state === 'ok' ? 1 : 0 }}
      onLoad={() => {
        markReady(src);
        noteFailed(src, false);
        setState('ok');
      }}
      onError={() => {
        if (isLocalSrc(src)) {
          onSourceFailed?.();
          return;
        }
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
  /* blob:/data: 后面拼查询串等于换了个不存在的地址，必然再败一次 */
  if (isLocalSrc(url)) return url;
  const sep = url.includes('&') ? '&' : (url.includes('?') ? '&' : '?');
  return `${url}${sep}_r=${Date.now()}_${attempt}`;
}
