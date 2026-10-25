import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useBackToHome } from '@/hooks/useBackToHome';
import { useOnline } from '@/hooks/useOnline';
import { usePlugin } from '@/store/PluginContext';
import { BG_VALUES, buildFilter } from '@/reader/prefs';
import { usePrefs } from './usePrefs';
import { usePrefetchNextChapter } from './usePrefetch';
import { useChapterPrefetch } from '@/hooks/useChapterPrefetch';
import { prefetchChapterEnhancement } from '@/reader/enhanceQueue';
import { onEnhanceActive, resetEnhanceActive } from '@/reader/enhanceCache';
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
import { useAutoNextChapter } from './useAutoNextChapter';
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
  const online = useOnline();

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
  /** 这一章有没有真出过增强图（顶栏那颗「画面+」的依据） */
  const [enhanceLive, setEnhanceLive] = useState(false);
  /** 上一帧看到的原图：换章加载时垫在下面，别让用户对着一块纯黑/纯白 */
  const [lastFrame, setLastFrame] = useState<string | null>(null);

  const isRTL = prefs.value.direction === 'rtl';

  /* ── 数据 ── */
  const { images, error, warning, loading, fromCache, record, reload, scrollRef } =
    useChapterLoader(plugin, slug, chapterId);

  const imageCount = images?.length ?? 0;
  /*
   * 自动下一章需要一个转接口：跳章的动作（gotoChapter）在 useReaderActions 里，
   * 而那个 hook 又吃 paging —— 直接互相引用接不上。
   * 所以 paging 和滚动回调拿的都是这个 ref，渲染完再把真实现换上去。
   */
  const autoRef = useRef<{
    atEnd: () => void;
    onScroll: (el: HTMLElement) => void;
    pullStart: () => void;
    pullHold: (on: boolean) => void;
  }>({ atEnd: () => {}, onScroll: () => {}, pullStart: () => {}, pullHold: () => {} });
  const paging = usePaging(imageCount, mode, prefs.value.pageMode, record, () =>
    autoRef.current.atEnd(),
  );

  const bookmarks = useBookmarks(plugin, chapterId);
  /* 目录里点名某一章时提前取地址表：冷章那 2~5 秒别全落在打开后的黑屏上 */
  const chapterPrefetch = useChapterPrefetch(plugin, slug, chapterId);

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
  /*
   * 接下一章进来时**不恢复**这一章存过的进度：那是"往前续读"，
   * 不是"重新打开这本书"。不这么做的话，看过一眼的下一章会把你甩到上次那页，
   * 看上去就是"进去之后自己往下跑了几页"。
   * 上拉、点章末那一行、分页模式往前翻一次都算"接下一章"，一律落在开头；
   * 从目录跳一章、下次再打开这本书照旧恢复 —— 那才是"回到上次那儿"。
   */
  const skipRestoreFor = useRef<string | null>(null);
  useRestoreProgress({
    mode,
    ready: !!images,
    percent: skipRestoreFor.current === chapterId ? 0 : progress.percent,
    scrollRef,
    totalPages: paging.totalPages,
    setPage: paging.setPage,
  });
  /*
   * 记号要留到**离开这一章**再清。
   *
   * 一开始是"图片一到就清"，结果 positions 是异步从 IndexedDB 读上来的：
   * 进章那一帧它是空的（恢复不跑），清掉记号之后位置才到货，
   * percent 从 0 变成 45 → 恢复的 effect 重新触发 → 人还是被甩到中段。
   * 现象就是"上拉进去之后画面自己往下跑几页"。
   */
  useEffect(() => {
    const marked = skipRestoreFor.current;
    if (marked && marked !== chapterId) skipRestoreFor.current = null;
  }, [chapterId]);

  const autoNext = useAutoNextChapter({
    enabled: prefs.value.autoNextChapter,
    pullMs: prefs.value.pullMs,
    nextId,
    images,
    onGo: (id) => {
      skipRestoreFor.current = id;
      gotoChapter(id);
    },
  });
  useEffect(() => {
    autoRef.current = autoNext;
  });

  /* ── 副作用 ── */
  useKeepAwake(prefs.value.keepAwake, !!images);
  const fs = useImmersiveFullscreen(prefs.value.immersive);
  /*
   * 滚动模式也要预热：分页有 ±2 的窗口，滚动下滑快时同样会追不上。
   * 滚动模式下 page 就是当前图片序号；只保留"当前 + 往后 2 张"，不囤整章。
   */
  useImagePreload(
    images,
    mode === 'paged' ? paging.startIndex : paging.currentImageIndex,
    mode === 'paged' ? paging.perPage : 1,
    !!images,
  );
  useEffect(() => {
    if (!images?.length) return;
    const i = Math.max(0, Math.min(images.length - 1, paging.currentImageIndex));
    setLastFrame(images[i] ?? null);
  }, [images, paging.currentImageIndex]);

  usePrefetchNextChapter({
    plugin,
    slug,
    nextId,
    ready: !!images && !loading && !error,
    perPage: paging.perPage,
  });

  /*
   * 画面增强的章级预取。章到手时排一次，之后每次挪位置再排一次 ——
   * 后排的那次不重算任何东西，只把"以脚下为起点"的顺序纠回来
   * （见 enhanceQueue.queueAhead：只准提前，不准延后）。
   * 不往下的话，跳章/读到一半重进时会站在黑屏里等前面十几张算完。
   */
  useEffect(() => {
    if (prefs.value.enhanceScreen) prefetchChapterEnhancement(images, paging.startIndex);
  }, [images, prefs.value.enhanceScreen, paging.startIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * 顶栏那颗「画面+」：开关开着不等于在增强 —— 源图本来就有屏幕那么宽时，
   * Worker 那一关直接判"不用放大"跳过，一张都不造。所以记的是"这一章真出过增强版"，
   * 由 enhanceCache 在每张结果进内存那一刻报上来（见 markActive）。换章清零。
   */
  useEffect(() => {
    resetEnhanceActive();
    setEnhanceLive(false);
    if (!prefs.value.enhanceScreen || !images) return;
    return onEnhanceActive(() => setEnhanceLive(true));
  }, [images, prefs.value.enhanceScreen]);

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
        /*
         * fromCache 只说明这一章来自 IndexedDB，不代表现在没网 ——
         * 以前在线也显示「离线」，和同步泡的「已同步」同屏打架。
         * 只有浏览器真的离线时才加这个前缀。
         */
        title={`${fromCache && !online ? '离线 · ' : ''}${
          mode === 'paged'
            ? `${paging.page + 1}/${paging.totalPages}`
            : `${paging.page + 1}/${imageCount || '?'}`
        }`}
        rtl={isRTL}
        mode={mode}
        marked={bookmarks.markedPages.has(paging.currentImageIndex)}
        enhanced={enhanceLive}
        canFullscreen={fs.supported}
        fullscreen={fs.active}
        onBack={back}
        onShelf={() => nav('/shelf')}
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
        lastFrame ? (
          <div className="reader__loading-frame" role="status" aria-live="polite">
            {/* 上一帧只当背景，不能参与翻页/进度；新章到手后整块被替换 */}
            <img src={lastFrame} alt="" aria-hidden="true" />
            <div className="reader__loading-hint">
              <span className="spinner" />
              <span>加载章节…</span>
            </div>
          </div>
        ) : (
          <Loading text="加载章节" />
        )
      ) : mode === 'scroll' ? (
        <ScrollView
          images={images}
          markedPages={bookmarks.markedPages}
          filter={filter}
          enhance={prefs.value.enhanceScreen}
          containerRef={scrollRef}
          hudVisible={bar.visible}
          resetToken={zoomTick}
          onScroll={(el) => {
            paging.onScroll(el, images.length, record);
            // 自动下一章看的是同一次滚动。读进度和"停在章末"必须是同一个来源，
            // 各接一遍的话早晚会出现"进度说 100%、章却还没接上"
            autoRef.current.onScroll(el);
          }}
          onPullStart={() => autoRef.current.pullStart()}
          onPullHold={(on) => autoRef.current.pullHold(on)}
          pull={autoNext.pull}
          endHint={
            autoNext.armed
              ? autoNext.ready
                ? '上拉接下一章'
                : '正在取最后几张…'
              : null
          }
          /*
           * 点那一行是明确意图，直接接；蓄力那套防的是"滑过头"，
           * 不是防"照着字按下去"。
           */
          onEndTap={() => autoNext.tapEnd()}
          onTap={bar.toggle}
          onZoom={(src, i) => setZoom({ src, i })}
          onZoomedChange={setZoomed}
        />
      ) : (
        <PagedStage
          images={images}
          paging={paging}
          filter={filter}
          enhance={prefs.value.enhanceScreen}
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
          hudVisible={bar.visible}
          /* 章末时底部那条热区也压在上拉提示行上：按下去要能算蓄力，不能只开进度条 */
          pullArmed={autoNext.armed}
          onPullStart={() => autoRef.current.pullStart()}
          onPullHold={(on) => autoRef.current.pullHold(on)}
          /* 大条浮起来的位置就是章末胶囊那儿，展开时先把菜单收掉，同屏只留一个悬浮件 */
          onRequestOpen={() => bar.setVisible(false)}
          onSeek={mode === 'paged' ? paging.seek : seekScroll}
          /*
           * 滚动模式拖到最右端松手 = 直接下一章，长章节最顺手的操作。
           * 这条只在抬手那一刻成立 —— 放在实时的 onSeek 里，拖过半程就会突然跳章。
           */
          onSeekEnd={
            mode === 'paged' || !nextId
              ? undefined
              : (ratio) => {
                  if (ratio > 0.97) gotoChapter(nextId);
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
        onPrefetchChapter={chapterPrefetch.prefetch}
        onPrefetchHover={chapterPrefetch.prefetchHover}
        onPrefetchNearest={chapterPrefetch.prefetchNearest}
        onJumpBookmark={(b) => {
          jumpToBookmark(b);
          panels.close();
        }}
      />
    </div>
  );
}
