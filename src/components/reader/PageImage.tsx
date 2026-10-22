import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RetryableImage,
  type ImageState,
  type RetryableImageProps,
} from '@/components/RetryableImage';
import { useEnhancedSource } from '@/reader/enhancePage';
import type { PagePhase } from './PageStatus';

/**
 * 阅读器里的一张页图。
 *
 * 比 RetryableImage 多两件事：
 *   1. 开着画面增强时，等这张进视野，按它此刻的显示宽度在 Worker 里重采样 + 补一版，
 *      回来就把 src 换掉。
 *   2. 把「拉图 / 增强 / 好了」这个阶段报给外层，由视图统一画提示。
 *
 * 为什么要单独一个组件：这个 hook 一张图一次，而 ScrollView / PagedCells
 * 都是在 map 里画图 —— 循环里不能调 hook。
 *
 * 换的是 src，不是叠覆盖层：object-fit 四档、翻页双缓冲那些逻辑全都不必知道
 * 有这回事。放大查看（ZoomView）走的是原图，不受这里影响 —— 那一层看的是原始像素，
 * 增强版是按屏幕宽度做的，套上去反而不对。
 */
export function PageImage({
  enhance,
  onPhase,
  onRetryReady,
  ...rest
}: RetryableImageProps & {
  enhance?: boolean;
  onPhase?: (phase: PagePhase) => void;
  /** 把「重试这一张」交出去，由所在视图的刷新按钮按需调用 */
  onRetryReady?: (src: string, retry: (() => void) | null) => void;
}) {
  const { ref, url, revert, reveal, forceOriginal } = useEnhancedSource(rest.src, !!enhance);
  const [state, setState] = useState<ImageState>('loading');
  const [reloadToken, setReloadToken] = useState(0);

  /*
   * 增强开着但这一页还没决定画什么，就是「画面增强中」——
   * 包括正在取原图字节、在排队、在 Worker 里算这三段，用户没必要分那么细。
   */
  const phase: PagePhase =
    enhance && !reveal
      ? 'enhance'
      : state === 'error'
        ? 'error'
        : state === 'loading'
          ? 'load'
          : 'ok';

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const retry = useCallback(() => {
    /* 等增强的：直接放弃增强、把已经拉到的原图画出来，比再排一轮快 */
    if (phaseRef.current === 'enhance') forceOriginal();
    /* 拉原图卡住的：换一个带绕缓存参数的地址重来 */
    else if (phaseRef.current === 'load') setReloadToken((n) => n + 1);
  }, [forceOriginal]);

  /* 整屏的刷新按钮点下来时，让没画出来的那一页重来一次 */
  const readyCb = useRef(onRetryReady);
  readyCb.current = onRetryReady;
  useEffect(() => {
    readyCb.current?.(rest.src, retry);
    return () => readyCb.current?.(rest.src, null);
  }, [rest.src, retry]);

  /* 状态报给分页那一层；阶段没变就不重复报（父级的回调每次渲染都是新函数） */
  const reported = useRef<PagePhase | null>(null);
  useEffect(() => {
    if (reported.current === phase) return;
    reported.current = phase;
    onPhase?.(phase);
  }, [phase, onPhase]);

  return (
    <RetryableImage
      {...rest}
      /*
       * 开着增强时一律 lazy：eager 会让浏览器在 <img> 挂上那一刻就去解原图，
       * 而滚动模式的前三张正是 eager 的 —— 那三张于是必然先画出原图、
       * 再被增强版硬换掉，恰好是要消掉的那一下。lazy 的页在进视口前根本不解码，
       * "第一帧画的是哪张图"就完全由我们决定。
       */
      eager={enhance ? false : rest.eager}
      imgRef={ref}
      src={url ?? rest.src}
      /* 增强版没就绪、而这张是第一次上屏：先不画，别让原图占住这一帧 */
      hidden={!reveal}
      /* 增强版挂了要立刻退回原图：它是锦上添花，没资格把一页好图换成「加载失败」 */
      onSourceFailed={url ? revert : undefined}
      onStateChange={setState}
      reloadToken={reloadToken}
    />
  );
}
