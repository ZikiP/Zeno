import { RetryableImage, type RetryableImageProps } from '@/components/RetryableImage';
import { useEnhancedSource } from '@/reader/enhance';

/**
 * 阅读器里的一张页图。
 *
 * 比 RetryableImage 多一件事：开着画面增强时，等这张进视野，按它此刻的显示宽度
 * 在 Worker 里重采样 + 补一版，回来就把 src 换掉。
 *
 * 为什么要单独一个组件：这个 hook 一张图一次，而 ScrollView / PagedCells
 * 都是在 map 里画图 —— 循环里不能调 hook。
 *
 * 换的是 src，不是叠覆盖层：object-fit 四档、翻页双缓冲、长按放大那些逻辑
 * 全都不必知道有这回事。放大查看（ZoomView）走的是原图，不受这里影响 ——
 * 那一层看的是原始像素，增强版是按屏幕宽度做的，套上去反而不对。
 */
export function PageImage({ enhance, ...rest }: RetryableImageProps & { enhance?: boolean }) {
  const { ref, url, revert } = useEnhancedSource(rest.src, !!enhance);
  return (
    <RetryableImage
      {...rest}
      imgRef={ref}
      src={url ?? rest.src}
      /* 增强版挂了要立刻退回原图：它是锦上添花，没资格把一页好图换成「加载失败」 */
      onSourceFailed={url ? revert : undefined}
    />
  );
}
