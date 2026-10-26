import EdgeHint from './EdgeHint';
import PagedView from './PagedView';
import type { Paging } from '@/pages/reader/usePaging';
import type { TurnAnim } from '@/reader/prefs';

/**
 * 分页舞台：一屏（或双屏）图片 + 边界提示。
 *
 * 从 ReaderPage 抽出来是因为那块 JSX 连着 EdgeHint 和"点中间开关悬浮件"的
 * 规则，读起来是"这一章怎么铺"而不是"页面里有谁"。
 */
export default function PagedStage({
  images,
  paging,
  filter,
  enhance,
  markedPages,
  rtl,
  anim,
  turnKey,
  hudVisible,
  resetToken,
  onToggleHud,
  onZoomedChange,
  prevId,
  nextId,
  onGoChapter,
}: {
  images: string[];
  paging: Paging;
  filter?: string;
  /** 画面增强（实验），跟 filter 一样是"这一屏怎么画"的事 */
  enhance?: boolean;
  markedPages: Set<number>;
  rtl: boolean;
  /** 翻页动画演哪一档，从阅读设置里来 */
  anim: TurnAnim;
  /** 换章时变一下，翻页动画只在章内演 */
  turnKey: string;
  /** 顶部菜单是否展开 */
  hudVisible: boolean;
  /** 变一次还原一次：右下角那颗按钮 */
  resetToken: number;
  onToggleHud: () => void;
  onZoomedChange: (zoomed: boolean) => void;
  prevId: string | null;
  nextId: string | null;
  onGoChapter: (id: string) => void;
}) {
  return (
    <PagedView
      images={images.slice(paging.startIndex, paging.startIndex + paging.perPage)}
      startIndex={paging.startIndex}
      perPage={paging.perPage}
      markedPages={markedPages}
      filter={filter}
      enhance={enhance}
      rtl={rtl}
      anim={anim}
      turnKey={turnKey}
      hudVisible={hudVisible}
      resetToken={resetToken}
      /*
       * 中间那块不翻页，只开关悬浮件（顶部条 + 章末胶囊）。
       * 分页模式没有滚动，bar 那套「向下滚隐藏、向上滚显示」永远不会被触发，
       * 不给它接一条 toggle 的话 HUD 就钉死在屏幕上了。
       */
      onTapZone={(side) => (side === 'center' ? onToggleHud() : paging.tap(side, rtl))}
      onSwipe={(dir) => (dir === 'forward' ? paging.goForward() : paging.goBack())}
      onZoomedChange={onZoomedChange}
      edgeHint={
        <EdgeHint
          page={paging.page}
          totalPages={paging.totalPages}
          hasPrevChapter={!!prevId}
          hasNextChapter={!!nextId}
          armed={hudVisible}
          onGoPrev={() => prevId && onGoChapter(prevId)}
          onGoNext={() => nextId && onGoChapter(nextId)}
        />
      }
    />
  );
}
