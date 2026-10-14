import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getChapter } from '@/site/engine';
import {
  addBookmark,
  cacheChapterImages,
  getBookmarks,
  getCachedChapter,
  getShelf,
  savePosition,
  type Bookmark,
} from '@/store/db';
import { usePlugin } from '@/store/PluginContext';
import {
  BG_LABELS,
  BG_VALUES,
  DEFAULT_PREFS,
  loadPrefs,
  savePrefs,
  type ReaderPrefs,
} from '@/reader/prefs';
import {
  IconBack,
  IconBookmark,
  IconChevronLeft,
  IconChevronRight,
  IconDouble,
  IconGrid,
  IconList,
  IconMoon,
  IconSettings,
  IconSun,
  IconZoom,
} from '@/components/Icons';
import ChapterDrawer from '@/components/ChapterDrawer';
import BookmarkPanel from '@/components/BookmarkPanel';
import { RetryableImage } from '@/components/RetryableImage';
import { ErrorBox, Loading, Sheet } from '@/components/UI';

type Mode = 'scroll' | 'paged';

export default function ReaderPage({ slug, chapterId }: { slug: string; chapterId: string }) {
  const nav = useNavigate();
  const { plugin } = usePlugin();
  const [searchParams] = useSearchParams();

  /* 前后章节。详情页跳转时带在 URL 查询参数里，刷新也不丢 */
  const prevId = searchParams.get('p');
  const nextId = searchParams.get('n');

  const [images, setImages] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(
    () => localStorage.getItem('readerMode') === 'paged' ? 'paged' : 'scroll',
  );
  const [prefs, setPrefs] = useState<ReaderPrefs>(DEFAULT_PREFS);

  const [showBar, setShowBar] = useState(true);
  const [showSheet, setShowSheet] = useState(false);
  const [page, setPage] = useState(0);
  const [fromCache, setFromCache] = useState(false);
  const [zoom, setZoom] = useState<{ src: string; i: number } | null>(null);

  /* 章节目录 / 书签面板 */
  const [showChapters, setShowChapters] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  /** 本章有书签的页码。目录里靠它标记 */
  const [markedPages, setMarkedPages] = useState<Set<number>>(new Set());
  /** 全部书签，用于面板。key = chapterId，值是页码数组 */
  const [bookmarkMap, setBookmarkMap] = useState<Map<string, number[]>>(new Map());

  const scrollRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const preloaded = useRef(new Set<string>());

  /* 书签数据：进入章节时读一次 */
  const loadBookmarks = useCallback(async () => {
    if (!plugin?.meta.id) return;
    const all = await getBookmarks(plugin.meta.id);
    const map = new Map<string, number[]>();
    for (const b of all) {
      const arr = map.get(b.chapterId) ?? [];
      arr.push(b.page);
      map.set(b.chapterId, arr);
    }
    setBookmarkMap(map);
    setMarkedPages(new Set(map.get(chapterId) ?? []));
  }, [plugin?.meta.id, chapterId]);

  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks]);

  /* 提示条：3 秒后自动消失 */
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);


  /* 偏好设置 */
  useEffect(() => {
    setPrefs(loadPrefs());
  }, []);
  const updatePrefs = useCallback((patch: Partial<ReaderPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);

  /*
   * 保持屏幕常亮。
   * Wake Lock API 只能在用户手势之后申请，且页面隐藏时自动释放，
   * 所以这里在图片加载完（用户点进来算手势）后申请。
   */
  const lockRef = useRef<WakeLockSentinel | null>(null);
  useEffect(() => {
    if (!prefs.keepAwake || !images) return;
    let cancelled = false;

    const acquire = async () => {
      try {
        if (!('wakeLock' in navigator)) return;
        lockRef.current = await navigator.wakeLock.request('screen');
      } catch {
        /* 用户系统禁用了，或非安全上下文。忽略 */
      }
    };
    void acquire();

    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      void cancelled;
      document.removeEventListener('visibilitychange', onVisible);
      lockRef.current?.release().catch(() => {});
      lockRef.current = null;
    };
  }, [prefs.keepAwake, images]);

  /* 沉浸模式：隐藏浏览器 UI（全屏 API 在部分浏览器可用） */
  useEffect(() => {
    if (!prefs.immersive) return;
    const el = document.documentElement as HTMLElement & { requestFullscreen?: () => Promise<void> };
    // 不自动进入全屏 —— 浏览器要求用户手势，代码调用会被拒。
    // 这里只标记状态，实际全屏由用户点击「沉浸」按钮触发。
    void el;
  }, [prefs.immersive]);

  /* 加载章节 */
  useEffect(() => {
    if (!plugin?.meta.id) return;
    let cancelled = false;

    (async () => {
      setErr(null);
      setImages(null);
      setPage(0);
      preloaded.current.clear();

      try {
        const cached = await getCachedChapter(plugin.meta.id, slug, chapterId);
        if (cancelled) return;

        if (cached) {
          setImages(cached.images);
          setFromCache(true);
          return;
        }

        setFromCache(false);
        const result = await getChapter(plugin, slug, chapterId);
        if (cancelled) return;

        if (result.images.length === 0) {
          setErr('这一章没有图片。请检查插件的「章节正文 URL」与「图片属性」配置');
          return;
        }

        setImages(result.images);
        // 后台静默缓存，不阻塞阅读
        void cacheChapterImages(plugin.meta.id, slug, chapterId, result.images);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [plugin, slug, chapterId]);

  const isRTL = prefs.direction === 'rtl';
  /** 双页模式下每屏显示几张 */
  const perPage = prefs.pageMode === 'double' ? 2 : 1;
  const totalPages = images ? Math.ceil(images.length / perPage) : 0;

  const switchMode = useCallback((m: Mode) => {
    setMode(m);
    localStorage.setItem('readerMode', m);
    setPage(0);
  }, []);

  /** 当前页在「整章图片」里的序号，双页时取第一张 */
  const currentImageIndex = mode === 'paged' ? page * perPage : page;

  /** 书签已存在则移除，不存在则添加 */
  const toggleBookmark = useCallback(
    async (explicitPage?: number) => {
      if (!plugin?.meta.id || !images) return;
      const p = explicitPage ?? currentImageIndex;
      const existing = markedPages.has(p);

      if (existing) {
        const all = await getBookmarks(plugin.meta.id, slug);
        const hit = all.find((b) => b.chapterId === chapterId && b.page === p);
        if (hit) {
          const { removeBookmark } = await import('@/store/db');
          await removeBookmark(hit.key);
          setToast('已删除书签');
        }
      } else {
        await addBookmark({
          pluginId: plugin.meta.id,
          slug,
          chapterId,
          page: p,
          percent: images.length ? Math.round((p / images.length) * 100) : 0,
          thumb: images[p],
        });
        setToast(`已收藏第 ${p + 1} 页`);
      }
      await loadBookmarks();
    },
    [plugin?.meta.id, images, currentImageIndex, markedPages, slug, chapterId, loadBookmarks],
  );

  /** 跳到某个书签 */
  const jumpToBookmark = useCallback(
    (b: Bookmark) => {
      if (b.chapterId !== chapterId) {
        // 跨章跳转：走路由，并带上目标章的前后关系未知，清掉 p/n
        nav(`/read/${b.pluginId}/${b.slug}/${b.chapterId}`);
        return;
      }
      if (mode === 'paged') {
        setPage(Math.floor(b.page / perPage));
      } else {
        // 滚动模式：图片高度不一，用比例估算后再微调
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          const imgs = el?.querySelectorAll('.reader__page');
          const target = imgs?.[b.page] as HTMLElement | undefined;
          if (el && target) el.scrollTop = target.offsetTop - 8;
        });
      }
      setToast(`跳到第 ${b.page + 1} 页`);
    },
    [chapterId, mode, perPage, nav],
  );

  /** 切到相邻章节。前后 id 由详情页跳转时写在 URL 查询参数里 */
  const gotoChapter = useCallback(
    (id: string) => {
      if (!plugin?.meta.id) return;
      const sp = new URLSearchParams(searchParams);
      // 换了章节，前后关系要重算 —— 但我们不知道新的前后是谁，
      // 所以清掉，让阅读器自己退回"无前后章"状态。
      sp.delete('p');
      sp.delete('n');
      nav(`/read/${plugin.meta.id}/${slug}/${id}?${sp.toString()}`.replace('??', '?'));
    },
    [plugin?.meta.id, slug, nav, searchParams],
  );

  /* 记录进度 */
  const record = useCallback(
    (pos: number) => {
      if (!plugin?.meta.id) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void savePosition(plugin.meta.id, slug, chapterId, pos);
      }, 600);
    },
    [plugin, slug, chapterId],
  );

  /**
   * 滚动模式下的进度。
   * 竖向滚动不能按 clientWidth 算页码（那只在等宽布局下成立），
   * 这里改为只记录百分比，页码用「已滚动比例 × 总页数」估算。
   */
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const total = el.scrollHeight - el.clientHeight;
    if (total <= 0) return;

    const ratio = el.scrollTop / total;
    record(Math.round(ratio * 100));
    setPage(Math.min(images?.length ?? 1, Math.floor(ratio * (images?.length ?? 1)) + 1));

    // 向下滚动时自动隐藏工具栏，向上滚动时显示
    const prevTop = el.dataset.top ? Number(el.dataset.top) : el.scrollTop;
    el.dataset.top = String(el.scrollTop);
    if (Math.abs(el.scrollTop - prevTop) < 4) return;
    setShowBar(el.scrollTop < prevTop || el.scrollTop < 80);
  }, [record, images]);

  /** 翻页。RTL 时方向相反 */
  const goPage = useCallback(
    (delta: number) => {
      setPage((p) => {
        const next = p + delta;
        if (next < 0 || next >= totalPages) return p;
        return next;
      });
    },
    [totalPages],
  );

  /* 预加载：把当前页前后各 2 张塞进浏览器缓存，翻页不再等待 */
  useEffect(() => {
    if (!images || mode !== 'paged') return;
    const from = Math.max(0, page * perPage - 2);
    const to = Math.min(images.length, page * perPage + perPage + 2);
    for (let i = from; i < to; i++) {
      const src = images[i];
      if (!src || preloaded.current.has(src)) continue;
      preloaded.current.add(src);
      const img = new Image();
      img.src = src;
    }
  }, [images, page, perPage, mode]);

  /* 点击区域 */
  const onTapZone = useCallback(
    (side: 'left' | 'right' | 'center') => {
      if (side === 'center') {
        setShowBar((s) => !s);
        return;
      }
      // RTL：点右边 = 上一页（往前翻），与日漫一致
      const forward = isRTL ? side === 'left' : side === 'right';
      goPage(forward ? 1 : -1);
    },
    [goPage, isRTL],
  );

  /* 键盘：方向键、空格、Esc */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (zoom) setZoom(null);
        else nav(-1);
        return;
      }
      if (zoom) return;

      const forward = isRTL ? e.key === 'ArrowLeft' : e.key === 'ArrowRight';
      const back = isRTL ? e.key === 'ArrowRight' : e.key === 'ArrowLeft';

      if (forward) goPage(1);
      else if (back) goPage(-1);
      else if (e.key === ' ') {
        e.preventDefault();
        setShowBar((s) => !s);
      } else if (e.key.toLowerCase() === 'f') setShowBar((s) => !s);
      else if (e.key.toLowerCase() === 'd') {
        updatePrefs({ direction: isRTL ? 'ltr' : 'rtl' });
        setPage(0);
      } else if (e.key.toLowerCase() === 'b') {
        void toggleBookmark();
      } else if (e.key.toLowerCase() === 'c') {
        setShowChapters(true);
      } else if (e.key.toLowerCase() === 'k') {
        setShowBookmarks(true);
      } else if (e.key === '+' || e.key === '=') {
        updatePrefs({ brightness: Math.min(1, (prefs.brightness ?? 1) + 0.1) });
      } else if (e.key === '-') {
        updatePrefs({ brightness: Math.max(0.3, (prefs.brightness ?? 1) - 0.1) });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPage, isRTL, nav, prefs.brightness, updatePrefs, zoom, toggleBookmark]);

  /* 恢复阅读位置 */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !plugin?.meta.id || mode !== 'scroll' || !images) return;
    (async () => {
      const entry = (await getShelf(plugin.meta.id)).find((s) => s.slug === slug);
      const pct = entry?.positions?.[chapterId];
      if (pct && pct > 2 && pct < 98) {
        requestAnimationFrame(() => {
          el.scrollTop = ((el.scrollHeight - el.clientHeight) * pct) / 100;
        });
      }
    })();
  }, [images, mode, plugin?.meta.id, slug, chapterId]);

  /** 当前分页模式要显示的图片 */
  const visibleImages = useMemo(() => {
    if (!images) return [];
    return images.slice(page * perPage, page * perPage + perPage);
  }, [images, page, perPage]);

  /* 离开前保存进度 */
  useEffect(() => {
    return () => {
      if (plugin?.meta.id && images && mode === 'scroll') {
        const el = scrollRef.current;
        if (el) {
          const total = el.scrollHeight - el.clientHeight;
          if (total > 0) {
            void savePosition(plugin.meta.id, slug, chapterId, Math.round((el.scrollTop / total) * 100));
          }
        }
      }
    };
  }, [plugin?.meta.id, images, mode, slug, chapterId]);

  const filter = useMemo(() => {
    const parts: string[] = [];
    if (prefs.brightness !== null) parts.push(`brightness(${prefs.brightness})`);
    if (prefs.grayscale) parts.push('grayscale(1)');
    return parts.length ? `filter: ${parts.join(' ')}` : undefined;
  }, [prefs.brightness, prefs.grayscale]);

  if (zoom) {
    return (
      <div className="zoom-view" style={{ background: BG_VALUES[prefs.bgColor] }}>
        <RetryableImage src={zoom.src} alt={`第 ${zoom.i + 1} 页`} onClick={() => setZoom(null)} />
        <div className="zoom-view__hint">点击任意处关闭</div>
      </div>
    );
  }

  return (
    <div className="reader" style={{ background: BG_VALUES[prefs.bgColor] }}>
      <div className={`reader__bar${showBar ? '' : ' hide'}`}>
        <button className="icon-btn" onClick={() => nav(-1)} aria-label="返回">
          <IconBack />
        </button>
        <div className="reader__title">
          {fromCache && '离线 · '}
          {mode === 'paged' ? `${page + 1} / ${totalPages}` : `${page + 1} / ${images?.length ?? '?'}`}
          {prefs.direction === 'rtl' && ' ←右起'}
        </div>
        <button className="icon-btn" onClick={() => setShowSheet(true)} aria-label="阅读设置">
          <IconSettings />
        </button>
        <button className="icon-btn" onClick={() => setShowChapters(true)} aria-label="章节目录">
          <IconList />
        </button>
        <button className="icon-btn" onClick={() => setShowBookmarks(true)} aria-label="书签">
          <IconBookmark />
        </button>
        <button
          className={`icon-btn${markedPages.has(currentImageIndex) ? ' is-on' : ''}`}
          onClick={() => void toggleBookmark()}
          aria-label="收藏本页"
          title={markedPages.has(currentImageIndex) ? '取消收藏本页' : '收藏本页'}
        >
          <IconBookmark filled={markedPages.has(currentImageIndex)} />
        </button>
        <button
          className="icon-btn"
          onClick={() => switchMode(mode === 'scroll' ? 'paged' : 'scroll')}
          aria-label="切换模式"
        >
          {mode === 'scroll' ? <IconGrid /> : <IconList />}
        </button>
      </div>

      {err ? (
        <ErrorBox message={err} onRetry={() => nav(0)} />
      ) : !images ? (
        <Loading text="加载章节" />
      ) : mode === 'scroll' ? (
        /* 竖向滚动：连续下滑 */
        <div className="reader__scroll" ref={scrollRef} onScroll={onScroll} style={{ filter }}>
          {images.map((src, i) => (
            <div key={src + i} className="reader__item">
              <RetryableImage
                className="reader__page"
                src={src}
                alt={`第 ${i + 1} 页`}
                eager={i < 3}
                onClick={() => setShowBar((s) => !s)}
                onDoubleClick={() => setZoom({ src, i })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setZoom({ src, i });
                }}
              />
              {markedPages.has(i) && (
                <span className="reader__bm-mark" title="已收藏">
                  <IconBookmark size={13} filled />
                </span>
              )}
            </div>
          ))}
          <div className="reader__end">— 本章完 —</div>

          {/* 读完接着下一章，不用退回详情页 */}
          <div className="reader__nav">
            {prevId && (
              <button className="btn btn--ghost" onClick={() => gotoChapter(prevId)}>
                上一章
              </button>
            )}
            {nextId ? (
              <button className="btn" onClick={() => gotoChapter(nextId)}>
                下一章
              </button>
            ) : (
              <span className="reader__nav-end">已是最新章节</span>
            )}
          </div>
        </div>
      ) : (
        /* 分页模式 */
        <div className="reader__paged" style={{ filter }}>
          <div className={`reader__spread${perPage === 2 ? ' is-double' : ''}`}>
            {visibleImages.map((src, i) => {
              const abs = page * perPage + i;
              return (
                <div key={src} className="reader__cell">
                  <RetryableImage
                    src={src}
                    alt={`第 ${abs + 1} 页`}
                    onDoubleClick={() => setZoom({ src, i: abs })}
                  />
                  {markedPages.has(abs) && (
                    <span className="reader__bm-mark" title="已收藏">
                      <IconBookmark size={13} filled />
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* 左右点击区。中间留一条不响应翻页的区域，避免误触 */}
          <div className="paged-tap paged-tap--l" onClick={() => onTapZone('left')} />
          <div className="paged-tap paged-tap--r" onClick={() => onTapZone('right')} />
          <div className="paged-tap paged-tap--c" onClick={() => onTapZone('center')} />

          {/*
            页内边界：先给提示，告诉用户已到头。
            再点一次就直接切章节 —— 追更时这个衔接很重要。
          */}
          {page === 0 && (
            <button
              className="edge-hint"
              onClick={() => {
                if (showBar) return;
                if (prevId) gotoChapter(prevId);
              }}
            >
              {prevId ? (
                <>
                  <IconChevronRight size={18} /> 上一章
                </>
              ) : (
                <>
                  <IconChevronRight size={18} /> 已是第一章
                </>
              )}
            </button>
          )}
          {page === totalPages - 1 && (
            <button
              className="edge-hint"
              onClick={() => {
                if (showBar) return;
                if (nextId) gotoChapter(nextId);
              }}
            >
              {nextId ? (
                <>
                  下一章 <IconChevronLeft size={18} />
                </>
              ) : (
                <>
                  已是最后一章 <IconChevronLeft size={18} />
                </>
              )}
            </button>
          )}
        </div>
      )}

      {/* 底部进度条 */}
      {images && (
        <div
          className="reader__progress"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            if (mode === 'paged') {
              setPage(Math.max(0, Math.min(totalPages - 1, Math.floor(ratio * totalPages))));
            } else if (ratio > 0.97) {
              // 滚动模式点最右端 = 跳到下一章，这是长章节最顺手的操作
              if (nextId) gotoChapter(nextId);
            }
          }}
        >
          {/* 已收藏的页在进度条上标出来 */}
          {mode === 'paged' &&
            [...markedPages].map((p) => (
              <span
                key={p}
                className="reader__progress-bm"
                style={{ left: `${((p / images.length) * 100).toFixed(2)}%` }}
              />
            ))}
          <div
            className="reader__progress-fill"
            style={{
              width: `${((mode === 'paged' ? page + 1 : page) / (mode === 'paged' ? totalPages : images.length)) * 100}%`,
            }}
          />
        </div>
      )}

      {/* 提示条 */}
      {toast && <div className="reader__toast">{toast}</div>}

      {/* 章节目录 */}
      {showChapters && plugin?.meta.id && (
        <ChapterDrawer
          pluginId={plugin.meta.id}
          slug={slug}
          currentId={chapterId}
          bookmarks={bookmarkMap}
          onPick={gotoChapter}
          onClose={() => setShowChapters(false)}
        />
      )}

      {/* 书签 */}
      {showBookmarks && plugin?.meta.id && (
        <BookmarkPanel
          pluginId={plugin.meta.id}
          onJump={jumpToBookmark}
          onClose={() => setShowBookmarks(false)}
        />
      )}

      {showSheet && (
        <PrefsSheet
          prefs={prefs}
          mode={mode}
          fromCache={fromCache}
          onChange={updatePrefs}
          onMode={switchMode}
          onClose={() => setShowSheet(false)}
        />
      )}
    </div>
  );
}

/* ── 设置面板 ─────────────────────────────────────── */

function PrefsSheet({
  prefs,
  mode,
  fromCache,
  onChange,
  onMode,
  onClose,
}: {
  prefs: ReaderPrefs;
  mode: Mode;
  fromCache: boolean;
  onChange: (p: Partial<ReaderPrefs>) => void;
  onMode: (m: Mode) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="阅读设置" onClose={onClose}>
      <div className="prefs-section">
        <div className="prefs-section__title">阅读方式</div>
        <div className="seg">
          {(['scroll', 'paged'] as const).map((m) => (
            <button
              key={m}
              className={`seg__item${mode === m ? ' on' : ''}`}
              onClick={() => onMode(m)}
            >
              {m === 'scroll' ? '竖向滚动' : '左右翻页'}
            </button>
          ))}
        </div>
        <div className="prefs-hint">
          {mode === 'scroll'
            ? '像刷网页一样连续下滑。适合手机、长章节。'
            : '一屏一页，点击左右区域翻页。适合平板、显示器。'}
        </div>
      </div>

      {mode === 'paged' && (
        <div className="prefs-section">
          <div className="prefs-section__title">翻页设置</div>

          <button className="pref-row" onClick={() => onChange({ direction: prefs.direction === 'rtl' ? 'ltr' : 'rtl' })}>
            <IconList size={18} />
            <div className="pref-row__text">
              <div className="pref-row__label">翻页方向</div>
              <div className="pref-row__hint">
                {prefs.direction === 'rtl' ? '右起翻页（日漫习惯）' : '左起翻页（国漫/韩漫习惯）'}
              </div>
            </div>
            <span className="pref-row__value">{prefs.direction === 'rtl' ? '右起' : '左起'}</span>
          </button>

          <button
            className="pref-row"
            onClick={() => onChange({ pageMode: prefs.pageMode === 'single' ? 'double' : 'single' })}
          >
            <IconDouble size={18} />
            <div className="pref-row__text">
              <div className="pref-row__label">双页显示</div>
              <div className="pref-row__hint">
                {prefs.pageMode === 'double' ? '横屏一屏两页' : '一屏一页'}
                {prefs.pageMode === 'double' && ' · 建议配合横屏'}
              </div>
            </div>
            <span className="pref-row__value">{prefs.pageMode === 'double' ? '开' : '关'}</span>
          </button>
        </div>
      )}

      <div className="prefs-section">
        <div className="prefs-section__title">显示</div>

        <div className="pref-row pref-row--static">
          <div className="pref-row__text">
            <div className="pref-row__label">背景色</div>
            <div className="pref-row__hint">纯黑最省电，护眼色适合长时间</div>
          </div>
          <div className="swatches">
            {(Object.keys(BG_LABELS) as (keyof typeof BG_LABELS)[]).map((c) => (
              <button
                key={c}
                className={`swatch${prefs.bgColor === c ? ' on' : ''}`}
                style={{ background: BG_VALUES[c] }}
                onClick={() => onChange({ bgColor: c })}
                title={BG_LABELS[c]}
              />
            ))}
          </div>
        </div>

        <div className="pref-row pref-row--static">
          <IconSun size={18} />
          <div className="pref-row__text">
            <div className="pref-row__label">亮度</div>
            <div className="pref-row__hint">
              {prefs.brightness === null ? '跟随系统' : `${Math.round(prefs.brightness * 100)}%`}
            </div>
          </div>
          <div className="slider-wrap">
            <input
              type="range"
              min={30}
              max={100}
              value={Math.round((prefs.brightness ?? 1) * 100)}
              onChange={(e) => onChange({ brightness: Number(e.target.value) / 100 })}
            />
            {prefs.brightness !== null && (
              <button className="slider-reset" onClick={() => onChange({ brightness: null })}>
                还原
              </button>
            )}
          </div>
        </div>

        <button className="pref-row" onClick={() => onChange({ grayscale: !prefs.grayscale })}>
          <IconZoom size={18} />
          <div className="pref-row__text">
            <div className="pref-row__label">灰度显示</div>
            <div className="pref-row__hint">去掉颜色，省流量</div>
          </div>
          <div className={`switch${prefs.grayscale ? ' on' : ''}`} />
        </button>

        <button className="pref-row" onClick={() => onChange({ keepAwake: !prefs.keepAwake })}>
          <IconMoon size={18} />
          <div className="pref-row__text">
            <div className="pref-row__label">保持屏幕常亮</div>
            <div className="pref-row__hint">阅读时不自动锁屏，省得反复点亮</div>
          </div>
          <div className={`switch${prefs.keepAwake ? ' on' : ''}`} />
        </button>
      </div>

      <div className="prefs-section">
        <div className="prefs-section__title">关于</div>
        <div className="pref-row pref-row--static">
          <IconZoom size={18} />
          <div className="pref-row__text">
            <div className="pref-row__label">长按或双击图片</div>
            <div className="pref-row__hint">放大查看细节，点击任意处关闭</div>
          </div>
        </div>
        <div className="pref-row pref-row--static">
          <IconList size={18} />
          <div className="pref-row__text">
            <div className="pref-row__label">键盘快捷键（电脑端）</div>
            <div className="pref-row__hint">
              ← → 翻页　空格 工具栏　D 切换方向　+ - 亮度　Esc 返回
            </div>
          </div>
        </div>
        <div className="pref-row pref-row--static">
          <IconBack size={18} />
          <div className="pref-row__text">
            <div className="pref-row__label">离线缓存</div>
            <div className="pref-row__hint">
              {fromCache ? '当前章节来自本机缓存' : '打开过的章节会自动缓存，断网可读'}
            </div>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
