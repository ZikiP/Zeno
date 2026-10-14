import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePlugin } from '@/store/PluginContext';
import { getShelf } from '@/store/shelf';
import type { Bookmark } from '@/store/db';
import { BG_VALUES, DEFAULT_PREFS } from '@/reader/prefs';
import { usePrefs } from './usePrefs';
import { useChapterLoader, useRestoreScrollPosition } from './useChapterLoader';
import { useBookmarks } from './useBookmarks';
import { useKeepAwake, useImagePreload } from './useReaderEffects';
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
  const { images, error, loading, fromCache, record, scrollRef } = useChapterLoader(
    plugin,
    slug,
    chapterId,
  );

  const imageCount = images?.length ?? 0;
  const paging = usePaging(imageCount, mode, prefs.value.pageMode);

  const bookmarks = useBookmarks(plugin, chapterId);

  /* ── 章节跳转 ── */
  const gotoChapter = useCallback(
    (id: string) => {
      if (!plugin?.meta.id) return;
      /*
       * 不带 p/n：换了章就不知道新的前后关系了，
       * 带着旧的过去会指错章。
       */
      nav(`/read/${plugin.meta.id}/${slug}/${id}`);
    },
    [plugin?.meta.id, slug, nav],
  );

  /* ── 提示条 ── */
  const flash = useCallback((text: string) => setToast(text), []);
  const clearToast = useCallback(() => setToast(null), []);
  useAutoDismiss(toast, clearToast);

  /* ── 进度恢复（仅滚动模式） ── */
  const savedPercent = useSavedPercent(plugin?.meta.id, slug, chapterId);
  useRestoreScrollPosition(mode === 'scroll' && !!images, savedPercent, scrollRef);

  /* ── 副作用 ── */
  useKeepAwake(prefs.value.keepAwake, !!images);
  useImagePreload(images, paging.startIndex, paging.perPage, mode === 'paged');

  /* ── 动作 ── */
  const scrollToPage = useCallback(
    (p: number) => {
      if (mode === 'paged') {
        paging.setPage(Math.floor(p / paging.perPage));
        return;
      }
      const el = scrollRef.current;
      const target = el?.querySelectorAll('.reader__page')[p] as HTMLElement | undefined;
      if (el && target) el.scrollTop = target.offsetTop - 8;
    },
    [mode, paging],
  );

  const toggleMark = useCallback(async () => {
    if (!images) return;
    const added = await bookmarks.toggle(paging.currentImageIndex, {
      plugin,
      slug,
      chapterId,
      images,
    });
    flash(added ? '已收藏本页' : '已删除书签');
  }, [images, bookmarks, paging.currentImageIndex, plugin, slug, chapterId, flash]);

  const jumpToBookmark = useCallback(
    (b: Bookmark) => {
      if (b.slug !== slug || b.chapterId !== chapterId) {
        nav(`/read/${plugin?.meta.id ?? ''}/${slug}/${b.chapterId}`);
        return;
      }
      scrollToPage(b.page);
      flash(`跳到第 ${b.page + 1} 页`);
    },
    [slug, chapterId, plugin?.meta.id, nav, scrollToPage, flash],
  );

  const switchMode = useCallback((m: ReaderMode) => {
    setMode(m);
    localStorage.setItem('readerMode', m);
    paging.setPage(0);
  }, [paging]);

  /* ── 快捷键 ── */
  useReaderHotkeys(
    {
      goForward: paging.goForward,
      goBack: paging.goBack,
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
        <ErrorBox message={error} onRetry={() => nav(0)} />
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
          onTapZone={(side) => paging.tap(side, isRTL)}
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

/* ── 局部工具 ─────────────────────────────────────── */

/** 亮度 + 灰度合成一条 CSS filter */
function buildFilter(prefs: { brightness: number | null; grayscale: boolean }): string | undefined {
  const parts: string[] = [];
  if (prefs.brightness !== null) parts.push(`brightness(${prefs.brightness})`);
  if (prefs.grayscale) parts.push('grayscale(1)');
  return parts.length ? `filter: ${parts.join(' ')}` : undefined;
}

/**
 * 从书架记录里读上次读到百分之几。
 * 只在切章时读一次 —— 滚动过程中反复读 IndexedDB 没必要。
 */
function useSavedPercent(
  pluginId: string | undefined,
  slug: string,
  chapterId: string,
): number {
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!pluginId) return;

    void getShelf(pluginId).then((shelf) => {
      if (cancelled) return;
      const entry = shelf.find((s) => s.slug === slug);
      setPercent(entry?.positions?.[chapterId] ?? 0);
    });

    return () => {
      cancelled = true;
    };
  }, [pluginId, slug, chapterId]);

  return percent;
}

/** 提示条 2.6 秒后自动消失 */
function useAutoDismiss(text: string | null, clear: () => void) {
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(clear, 2600);
    return () => clearTimeout(t);
  }, [text, clear]);
}
