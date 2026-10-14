import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getChapter } from '@/site/twmanga';
import {
  cacheChapterImages,
  getCachedChapter,
  getShelf,
  savePosition,
} from '@/store/db';
import { IconBack, IconGrid, IconList, IconSettings } from '@/components/Icons';
import { ErrorBox, Loading, Sheet } from '@/components/UI';

type Mode = 'scroll' | 'paged';

export default function ReaderPage() {
  const { slug = '', chapterId = '' } = useParams();
  const nav = useNavigate();

  const [images, setImages] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(
    () => (localStorage.getItem('readerMode') as Mode) || 'scroll',
  );
  const [showBar, setShowBar] = useState(true);
  const [showSheet, setShowSheet] = useState(false);
  const [page, setPage] = useState(0);
  const [fromCache, setFromCache] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  /** 加载：先看本地缓存，没有再抓网络并顺手缓存 */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setErr(null);
      setImages(null);
      setPage(0);

      try {
        const cached = await getCachedChapter(slug, chapterId);
        if (cancelled) return;

        if (cached) {
          setImages(cached.images);
          setFromCache(true);
          return;
        }

        setFromCache(false);
        const result = await getChapter(slug, chapterId);
        if (cancelled) return;

        if (result.images.length === 0) {
          setErr('这一章没有图片，可能站点结构变了');
          return;
        }

        setImages(result.images);

        // 后台静默缓存，不阻塞阅读
        void cacheChapterImages(slug, chapterId, result.images);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [slug, chapterId]);

  const switchMode = (m: Mode) => {
    setMode(m);
    localStorage.setItem('readerMode', m);
    if (m === 'scroll') setPage(0);
    else setPage(0);
  };

  /** 记录阅读进度（节流） */
  const record = useCallback(
    (pos: number) => {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        savePosition(slug, chapterId, pos);
      }, 600);
    },
    [slug, chapterId],
  );

  /* 竖向滚动模式：滚动即切页 + 进度 */
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const total = el.scrollHeight - el.clientHeight;
    if (total > 0) {
      record(Math.round((el.scrollTop / total) * 100));
    }
    const w = el.clientWidth;
    setPage(Math.min(images?.length ?? 1, Math.floor(el.scrollTop / w) + 1));
    // 滚到底自动隐藏工具栏
    if (el.scrollTop > 200) setShowBar(false);
  }, [record, images]);

  /* 分页模式：左右分区点击翻页 */
  const onTapZone = useCallback(
    (side: 'prev' | 'next') => {
      setShowBar((s) => !s);
      if (side === 'prev' && page > 0) setPage((p) => p - 1);
      if (side === 'next' && images && page < images.length - 1) setPage((p) => p + 1);
    },
    [page, images],
  );

  /* 键盘：桌面端左右键翻页，空格切换工具栏 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') onTapZone('prev');
      else if (e.key === 'ArrowRight') onTapZone('next');
      else if (e.key === ' ') {
        e.preventDefault();
        setShowBar((s) => !s);
      } else if (e.key === 'Escape') nav(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onTapZone, nav]);

  /* 进入时恢复上次的滚动位置 */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || mode !== 'scroll' || !images) return;
    (async () => {
      const shelf = await getShelf();
      const entry = shelf.find((s) => s.slug === slug);
      const pct = entry?.positions?.[chapterId];
      if (pct && pct > 2 && pct < 98) {
        requestAnimationFrame(() => {
          el.scrollTop = ((el.scrollHeight - el.clientHeight) * pct) / 100;
        });
      }
    })();
  }, [images, mode, slug, chapterId]);

  const current = images?.[page];

  return (
    <div className="reader">
      <div className={`reader__bar${showBar ? '' : ' hide'}`}>
        <button className="icon-btn" onClick={() => nav(-1)} aria-label="返回">
          <IconBack />
        </button>
        <div className="reader__title">
          {fromCache && '离线 · '}
          {page + 1} / {images?.length ?? '?'}
        </div>
        <button
          className="icon-btn"
          onClick={() => switchMode(mode === 'scroll' ? 'paged' : 'scroll')}
          aria-label="切换模式"
        >
          {mode === 'scroll' ? <IconGrid /> : <IconList />}
        </button>
        <button className="icon-btn" onClick={() => setShowSheet(true)} aria-label="设置">
          <IconSettings />
        </button>
      </div>

      {err ? (
        <ErrorBox message={err} onRetry={() => nav(0)} />
      ) : !images ? (
        <Loading text="加载章节" />
      ) : mode === 'scroll' ? (
        <div className="reader__scroll" ref={scrollRef} onScroll={onScroll}>
          {images.map((src, i) => (
            <img
              key={src + i}
              className="reader__page"
              src={src}
              alt={`第 ${i + 1} 页`}
              loading={i < 3 ? 'eager' : 'lazy'}
              decoding="async"
              onClick={() => setShowBar((s) => !s)}
            />
          ))}
          <div style={{ height: 40 }} />
        </div>
      ) : (
        <div className="reader__paged">
          <img src={current} alt={`第 ${page + 1} 页`} decoding="async" />
          <div className="paged-tap paged-tap--prev" onClick={() => onTapZone('prev')} />
          <div className="paged-tap paged-tap--next" onClick={() => onTapZone('next')} />
        </div>
      )}

      {showSheet && (
        <Sheet title="阅读设置" onClose={() => setShowSheet(false)}>
          <div className="opt-row" onClick={() => switchMode('scroll')}>
            <div>
              <div className="opt-row__label">竖向滚动</div>
              <div className="opt-row__hint">像刷网页一样连续下滑，适合长章节</div>
            </div>
            {mode === 'scroll' && <IconList size={18} />}
          </div>
          <div className="opt-row" onClick={() => switchMode('paged')}>
            <div>
              <div className="opt-row__label">左右翻页</div>
              <div className="opt-row__hint">点屏幕左右三分之一处翻页，不误触</div>
            </div>
            {mode === 'paged' && <IconGrid size={18} />}
          </div>
          <div className="opt-row">
            <div>
              <div className="opt-row__label">已缓存</div>
              <div className="opt-row__hint">
                打开过的章节会自动存到本机，断网也能看
              </div>
            </div>
            <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>
              {fromCache ? '当前来自缓存' : '当前来自网络'}
            </span>
          </div>
        </Sheet>
      )}
    </div>
  );
}
