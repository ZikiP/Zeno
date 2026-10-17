import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useBackToHome } from '@/hooks/useBackToHome';
import { usePlugin } from '@/store/PluginContext';
import { BG_VALUES, buildFilter } from '@/reader/prefs';
import { usePrefs } from './usePrefs';
import { usePrefetchNextChapter } from './usePrefetch';
import { useChapterLoader } from './useChapterLoader';
import { useChapterNeighbors } from './useChapterNeighbors';
import { useBookmarks } from './useBookmarks';
import {
  useAutoDismiss,
  useImagePreload,
  useImmersiveFullscreen,
  useKeepAwake,
  useRestoreProgress,
  useShelfProgress,
} from './useReaderEffects';
import { useReaderActions } from './useReaderActions';
import { useImageHealthFlash } from './useImageHealth';
import { useReaderHotkeys, nextBrightness } from './useReaderHotkeys';
import { usePaging, useToolbarVisibility, type ReaderMode } from './usePaging';
import ReaderPanel, { useReaderPanels } from './ReaderPanels';
import ReaderBar from '@/components/reader/ReaderBar';
import ScrollView from '@/components/reader/ScrollView';
import PagedStage from '@/components/reader/PagedStage';
import ZoomView from '@/components/reader/ZoomView';
import ChapterNav from '@/components/reader/ChapterNav';
import ZoomReset from '@/components/reader/ZoomReset';
import ReaderProgress from '@/components/reader/ReaderProgress';
import Toast from '@/components/reader/Toast';
import { ErrorBox, Loading } from '@/components/UI';

/**
 * 阅读器
 *
 * 只做编排：把数据交给 hook、把界面交给组件、把动作串起来。
 * 具体逻辑见同目录的 hooks 与 components/reader/。
 *
 * 规模控制见 CODE-STYLE.md：页面只该有「谁依赖谁」这层信息。
 */
export default function ReaderPage({ slug, chapterId }: { slug: string; chapterId: string }) {
  const nav = useNavigate();
  const back = useBackToHome();
  const { plugin } = usePlugin();
  const [searchParams] = useSearchParams();

  /* 前后章按缓存的章节表现算；URL 上的 p/n 只在没缓存时兜底 */
  const { prevId, nextId } = useChapterNeighbors(plugin?.meta.id, slug, chapterId, {
    prev: searchParams.get('p'),
    next: searchParams.get('n'),
  });

  /*
   * 偏好按书存：key 就是这本书在书架上的主键。
   * 插件还没同步到（plugin 为 null）时先只吃全局那份，别乱写记录。
   */
  const prefs = usePrefs(plugin ? `${plugin.meta.id}/${slug}` : null);
  const [mode, setMode] = useState<ReaderMode>(
    () => localStorage.getItem('readerMode') === 'paged' ? 'paged' : 'scroll',
  );

  const bar = useToolbarVisibility();
  const panels = useReaderPanels();
  const [zoom, setZoom] = useState<{ src: string; i: number } | null>(null);
  /*
   * 双指放大的状态由两种阅读视图各自持有（手势挂在自己的容器上），
   * 这里只留一份镜像用来决定右下角那颗还原按钮露不露。
   * zoomTick 变一次 = 视图里还原一次。
   */
  const [zoomed, setZoomed] = useState(false);
  const [zoomTick, setZoomTick] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const isRTL = prefs.value.direction === 'rtl';

  /* ── 数据 ── */
  const { images, error, warning, loading, fromCache, record, reload, scrollRef } =
    useChapterLoader(plugin, slug, chapterId);

  const imageCount = images?.length ?? 0;
  const paging = usePaging(imageCount, mode, prefs.value.pageMode, record);

  const bookmarks = useBookmarks(plugin, chapterId);

  /* ── 提示条 ── */
  const flash = useCallback((text: string) => setToast(text), []);
  const clearToast = useCallback(() => setToast(null), []);
  useAutoDismiss(toast, clearToast);

  /*
   * 章节没取完要说出来。图片照样能读、进度条照样走到底，
   * 不说一句的话用户只会以为「这一章就这么短」。
   */
  useEffect(() => {
    if (warning) flash(warning);
  }, [warning, flash]);
  useImageHealthFlash(images, flash);

  /* ── 动作（换章 / 收藏 / 跳书签 / 切模式）── */
  const { gotoChapter, toggleMark, jumpToBookmark, switchMode, seekScroll } = useReaderActions({
    plugin,
    slug,
    chapterId,
    images,
    mode,
    paging,
    bookmarks,
    scrollRef,

    nav,
    flash,
    setMode,
  });

  /* ── 进度：读出来、恢复回去 ── */
  const progress = useShelfProgress(plugin?.meta.id, slug, chapterId);
  useRestoreProgress({
    mode,
    ready: !!images,
    percent: progress.percent,
    scrollRef,
    totalPages: paging.totalPages,
    setPage: paging.setPage,
  });

  /* ── 副作用 ── */
  useKeepAwake(prefs.value.keepAwake, !!images);
  const fs = useImmersiveFullscreen(prefs.value.immersive);
  useImagePreload(images, paging.startIndex, paging.perPage, mode === 'paged');
  usePrefetchNextChapter({ plugin, slug, nextId, ready: !!images && !loading && !error });

  /* ── 快捷键 ── */
  useReaderHotkeys(
    {
      goForward: paging.goForward,
      goBack: paging.goBack,
      rtl: isRTL,
      toggleBar: bar.toggle,
      toggleDirection: () => prefs.patch({ direction: isRTL ? 'ltr' : 'rtl' }),
      toggleBookmark: () => void toggleMark(),
      openChapters: () => panels.open('chapters'),
      openBookmarks: () => panels.open('bookmarks'),
      adjustBrightness: (d) => prefs.patch({ brightness: nextBrightness(prefs.value.brightness, d) }),
      escape: () => {
        if (zoom) setZoom(null);
        else back();
      },
      zoomOpen: !!zoom,
    },
    [paging, bar, isRTL, prefs, toggleMark, panels, zoom, back],
  );

  /* ── 派生 ── */
  const filter = buildFilter(prefs.value);
  const bg = BG_VALUES[prefs.value.bgColor];

  /*
   * 换阅读方式时把手势所在的那个视图整个换掉了，它自己没机会说"我归位了"，
   * 这里的镜像会留下一个放大的假状态 —— 按钮白挂在右下角。
   */
  useEffect(() => setZoomed(false), [mode]);

  /* ── 放大层独占整个界面 ── */
  if (zoom) {
    return <ZoomView src={zoom.src} index={zoom.i} background={bg} onClose={() => setZoom(null)} />;
  }

  return (
    <div className="reader" data-fit={prefs.value.fit} style={{ background: bg }}>
      <ReaderBar
        visible={bar.visible}
        title={`${fromCache ? '离线 · ' : ''}${
          mode === 'paged'
            ? `${paging.page + 1} / ${paging.totalPages}`
            : `${paging.page + 1} / ${imageCount || '?'}`
        }`}
        rtl={isRTL}
        mode={mode}
        marked={bookmarks.markedPages.has(paging.currentImageIndex)}
        canFullscreen={fs.supported}
        fullscreen={fs.active}
        onBack={back}
        onSettings={() => panels.open('prefs')}
        onChapters={() => panels.open('chapters')}
        onBookmarks={() => panels.open('bookmarks')}
        onToggleMark={() => void toggleMark()}
        onToggleMode={() => switchMode(mode === 'scroll' ? 'paged' : 'scroll')}
        onToggleFullscreen={fs.toggle}
      />

      {error ? (
        /*
         * 重试必须走 reload（让 loader 的 nonce 前进、重新发请求）。
         * 之前这里是 nav(0) —— react-router 把数字当"历史回退 N 步"，
         * 0 步就是什么都不做，按钮看着能点、点了没反应。
         */
        <ErrorBox message={error} onRetry={reload} />
      ) : loading || !images ? (
        <Loading text="加载章节" />
      ) : mode === 'scroll' ? (
        <ScrollView
          images={images}
          markedPages={bookmarks.markedPages}
          filter={filter}
          containerRef={scrollRef}
          hudVisible={bar.visible}
          resetToken={zoomTick}
          onScroll={(el) => paging.onScroll(el, images.length, record)}
          onTap={bar.toggle}
          onZoom={(src, i) => setZoom({ src, i })}
          onZoomedChange={setZoomed}
        />
      ) : (
        <PagedStage
          images={images}
          paging={paging}
          filter={filter}
          markedPages={bookmarks.markedPages}
          rtl={isRTL}
          anim={prefs.value.turnAnim}
          turnKey={chapterId}
          hudVisible={bar.visible}
          resetToken={zoomTick}
          onToggleHud={bar.toggle}
          onZoom={(src, i) => setZoom({ src, i })}
          onZoomedChange={setZoomed}
          prevId={prevId}
          nextId={nextId}
          onGoChapter={gotoChapter}
        />
      )}

      {/*
        章末导航在两种模式下都要有，且跟着顶部菜单一起显隐：
        常驻的话它一直压在漫画最后一屏上，那是阅读时最不该占用的位置。
      */}
      {images && (
        <ChapterNav
          prevId={prevId}
          nextId={nextId}
          visible={bar.visible}
          onGo={gotoChapter}
        />
      )}

      {/* 放大过才出现，跟菜单一起显隐：菜单一开就归位，这时候没有东西要还原 */}
      {images && (
        <ZoomReset visible={zoomed && !bar.visible} onReset={() => setZoomTick((t) => t + 1)} />
      )}

      {images && (
        <ReaderProgress
          percent={paging.progressPercent}
          markedPositions={[...bookmarks.markedPages].map((p) => (p / images.length) * 100)}
          onSeek={
            mode === 'paged'
              ? paging.seek
              : // 滚动模式点最右端 = 直接下一章，长章节最顺手的操作；
                // 其余位置就跳到那一处（单位是滚动比例，和存下来的进度同一个口径）
                (ratio) => {
                  if (ratio > 0.97 && nextId) gotoChapter(nextId);
                  else seekScroll(ratio);
                }
          }
        />
      )}

      {toast && <Toast text={toast} />}

      <ReaderPanel
        panels={panels}
        plugin={plugin}
        mode={mode}
        prefs={prefs.value}
        fromCache={fromCache}
        onPrefsChange={prefs.patch}
        onModeChange={switchMode}
        currentChapter={{ slug, id: chapterId }}
        positions={progress.positions}
        bookmarksByChapter={bookmarks.byChapter}
        onPickChapter={gotoChapter}
        onJumpBookmark={(b) => {
          jumpToBookmark(b);
          panels.close();
        }}
      />
    </div>
  );
}
