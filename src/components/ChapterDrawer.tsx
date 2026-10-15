import { useEffect, useMemo, useRef, useState } from 'react';
import { getChapterList } from '@/store/chapters';

export interface ChapterRef {
  id: string;
  index: number;
  title: string;
}

/** 抽屉一次只挂这么多行，剩下的滚到底再补。见下面分批渲染那段注释 */
const BATCH = 80;

/**
 * 阅读器内的章节列表。
 *
 * 数据来源优先级：
 *   1. props 传入（详情页跳转时带来）
 *   2. 本地缓存（详情页抓过一次就存下来了）
 *   3. 都没有 → 提示回详情页
 *
 * 不在阅读器里重新抓章节表 —— 那是详情页的活，
 * 顺手缓存一次比重复请求划算得多。
 */
export default function ChapterDrawer({
  pluginId,
  slug,
  currentId,
  bookmarks,
  onPick,
  onClose,
}: {
  pluginId: string;
  slug: string;
  currentId: string;
  /** 该章有书签的页码，用于在目录里标记 */
  bookmarks: Map<string, number[]>;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [chapters, setChapters] = useState<ChapterRef[] | null>(null);
  const [comicTitle, setComicTitle] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = await getChapterList(pluginId, slug);
      if (cancelled) return;
      if (cached) {
        setChapters(cached.chapters);
        setComicTitle(cached.title);
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginId, slug]);

  /** 缓存里是升序（旧 → 新），倒过来让最新章排在最前 */
  const ordered = useMemo(() => (chapters ? [...chapters].reverse() : []), [chapters]);
  const currentPos = ordered.findIndex((c) => c.id === currentId);

  /*
   * 分批渲染。
   *
   * 起因是量到「打开目录要 1.5–2 秒」，但那个归因是错的：安静页面上一次挂 563 行
   * 实测 20ms，章节图片正在加载时开也一样，那两次读数复现不出来。所以这里不写
   * "因为一次渲染 563 行会卡"——那是没验证过的猜测。
   *
   * 分批本身仍然值得做，理由是可量化的那部分：列表高度从 25010px 降到 3612px，
   * 首屏 20ms → 11ms，而长篇漫画上千章时两万多像素的滚动区在手机上
   * 惯性滚动和内存都要吃满。
   */
  const [limit, setLimit] = useState(BATCH);
  useEffect(() => {
    setLimit(BATCH);
  }, [pluginId, slug]);

  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const rest = ordered.length - limit;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || rest <= 0) return;
    // 提前 400px 就开始补，滚到底时通常已经补好了，不会看到空档
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((n) => n + BATCH);
      },
      { root: listRef.current, rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rest]);

  const visible = useMemo(() => ordered.slice(0, limit), [ordered, limit]);

  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer__head">
          <div className="drawer__title">章节</div>
          {comicTitle && <div className="drawer__sub">{comicTitle}</div>}
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        {!loaded ? (
          <div className="loading">读取中</div>
        ) : !chapters || chapters.length === 0 ? (
          <div className="empty" style={{ padding: '40px 20px' }}>
            <div style={{ fontSize: 13 }}>章节列表还没缓存</div>
            <div style={{ fontSize: 11.5 }}>从漫画详情页进入一次即可</div>
          </div>
        ) : (
          <div className="drawer__list" ref={listRef}>
            {visible.map((c, i) => {
              const marks = bookmarks.get(c.id);
              return (
                <button
                  key={c.id}
                  className={`drawer__item${c.id === currentId ? ' on' : ''}`}
                  onClick={() => {
                    onPick(c.id);
                    onClose();
                  }}
                >
                  <span className="drawer__item-name">{c.title}</span>
                  {marks && marks.length > 0 && (
                    <span className="drawer__item-mark" title="有书签">
                      {marks.length}
                    </span>
                  )}
                  {i === currentPos && <span className="drawer__item-here">当前</span>}
                </button>
              );
            })}
            {rest > 0 && (
              <div className="drawer__more" ref={sentinelRef}>
                继续下滑加载，还有 {rest} 章
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
