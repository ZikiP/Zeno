import { RetryableImage, type RetryableImageProps } from '@/components/RetryableImage';
import { useEnhancedSource } from '@/reader/enhancePage';

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
  const { ref, url, revert, reveal } = useEnhancedSource(rest.src, !!enhance);
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
    />
  );
}
