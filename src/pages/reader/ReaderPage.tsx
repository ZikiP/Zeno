import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePlugin } from '@/store/PluginContext';
import { BG_VALUES, DEFAULT_PREFS, buildFilter } from '@/reader/prefs';
import { usePrefs } from './usePrefs';
import { useChapterLoader, useRestoreScrollPosition } from './useChapterLoader';
import { useBookmarks } from './useBookmarks';
import {
  useAutoDismiss,
  useImagePreload,
  useKeepAwake,
  useSavedPercent,
} from './useReaderEffects';
import { useReaderActions } from './useReaderActions';
import { useReaderHotkeys, nextBrightness } from './useReaderHotkeys';
import { usePaging, useToolbarVisibility, type ReaderMode } from './usePaging';
import ReaderPanel, { useReaderPanels } from './ReaderPanels';
import ReaderBar from '@/components/reader/ReaderBar';
import ScrollView from '@/components/reader/ScrollView';
import PagedView from '@/components/reader/PagedView';
import ZoomView from '@/components/reader/ZoomView';
import EdgeHint from '@/components/reader/EdgeHint';
import ChapterNav from '@/components/reader/ChapterNav';
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
  const { plugin } = usePlugin();
  const [searchParams] = useSearchParams();

  /* 前后章节由详情页写在 URL 查询参数里，刷新不丢 */
  const prevId = searchParams.get('p');
  const nextId = searchParams.get('n');

  const prefs = usePrefs(DEFAULT_PREFS);
  const [mode, setMode] = useState<ReaderMode>(
    () => localStorage.getItem('readerMode') === 'paged' ? 'paged' : 'scroll',
  );

  const bar = useToolbarVisibility();
  const panels = useReaderPanels();
  const [zoom, setZoom] = useState<{ src: string; i: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const isRTL = prefs.value.direction === 'rtl';

  /* ── 数据 ── */
  const { images, error, warning, loading, fromCache, record, reload, scrollRef } =
    useChapterLoader(plugin, slug, chapterId);

  const imageCount = images?.length ?? 0;
  const paging = usePaging(imageCount, mode, prefs.value.pageMode);

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

  /* ── 动作（换章 / 收藏 / 跳书签 / 切模式）── */
  const { gotoChapter, toggleMark, jumpToBookmark, switchMode } = useReaderActions({
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

  /* ── 进度恢复（仅滚动模式） ── */
  const savedPercent = useSavedPercent(plugin?.meta.id, slug, chapterId);
  useRestoreScrollPosition(mode === 'scroll' && !!images, savedPercent, scrollRef);

  /* ── 副作用 ── */
  useKeepAwake(prefs.value.keepAwake, !!images);
  useImagePreload(images, paging.startIndex, paging.perPage, mode === 'paged');

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
        else nav(-1);
      },
      zoomOpen: !!zoom,
    },
    [paging, bar, isRTL, prefs, toggleMark, panels, zoom, nav],
  );

  /* ── 派生 ── */
  const filter = buildFilter(prefs.value);
  const bg = BG_VALUES[prefs.value.bgColor];

  /* ── 放大层独占整个界面 ── */
  if (zoom) {
    return <ZoomView src={zoom.src} index={zoom.i} background={bg} onClose={() => setZoom(null)} />;
  }

  return (
    <div className="reader" style={{ background: bg }}>
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
        onBack={() => nav(-1)}
        onSettings={() => panels.open('prefs')}
        onChapters={() => panels.open('chapters')}
        onBookmarks={() => panels.open('bookmarks')}
        onToggleMark={() => void toggleMark()}
        onToggleMode={() => switchMode(mode === 'scroll' ? 'paged' : 'scroll')}
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
        <>
          <ScrollView
            images={images}
            markedPages={bookmarks.markedPages}
            filter={filter}
            onScroll={(el) => paging.onScroll(el, images.length, record)}
            onTap={bar.toggle}
            onZoom={(src, i) => setZoom({ src, i })}
          />
          <ChapterNav prevId={prevId} nextId={nextId} onGo={gotoChapter} />
        </>
      ) : (
        <PagedView
          images={images.slice(paging.startIndex, paging.startIndex + paging.perPage)}
          startIndex={paging.startIndex}
          perPage={paging.perPage}
          markedPages={bookmarks.markedPages}
          filter={filter}
          rtl={isRTL}
          onTapZone={(side) => paging.tap(side, isRTL)}
          onSwipe={(dir) => (dir === 'forward' ? paging.goForward() : paging.goBack())}
          onZoom={(src, i) => setZoom({ src, i })}
          edgeHint={
            <EdgeHint
              page={paging.page}
              totalPages={paging.totalPages}
              hasPrevChapter={!!prevId}
              hasNextChapter={!!nextId}
              armed={bar.visible}
              onGoPrev={() => prevId && gotoChapter(prevId)}
              onGoNext={() => nextId && gotoChapter(nextId)}
            />
          }
        />
      )}

      {images && (
        <ReaderProgress
          percent={
            mode === 'paged'
              ? ((paging.page + 1) / Math.max(1, paging.totalPages)) * 100
              : (paging.page / images.length) * 100
          }
          markedPositions={[...bookmarks.markedPages].map((p) => (p / images.length) * 100)}
          onSeek={
            mode === 'paged'
              ? paging.seek
              : // 滚动模式点最右端 = 直接下一章，长章节最顺手的操作
                (ratio) => {
                  if (ratio > 0.97 && nextId) gotoChapter(nextId);
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
