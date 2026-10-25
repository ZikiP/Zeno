import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getChapterList } from '@/store/chapters';
import { isRead } from '@/store/shelf';

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
  positions,
  bookmarks,
  onPick,
  onClose,
  onPrefetchChapter,
  onPrefetchHover,
  onPrefetchNearest,
}: {
  pluginId: string;
  slug: string;
  currentId: string;
  /** 各章进度。读过的章节压暗，跟详情页那份是同一个口径 */
  positions: Record<string, number>;
  /** 该章有书签的页码，用于在目录里标记 */
  bookmarks: Map<string, number[]>;
  onPick: (id: string) => void;
  onClose: () => void;
  /** 指针按下某章：先把它的地址表取回来（阅读器打开时直接命中） */
  onPrefetchChapter?: (id: string) => void;
  /** 悬停：停稳 300ms 才算想看，防鼠标扫列表时一路解析 */
  onPrefetchHover?: (id: string) => void;
  /** 目录滚动停稳：猜视口中央那一章 */
  onPrefetchNearest?: (list: HTMLElement | null) => void;
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

  /*
   * 默认批次必须把当前章包进来。
   *
   * 列表是「最新 → 最旧」，只挂前 80 行时，正在读第 111 章的人打开目录只能
   * 看到最新 80 章，当前章根本不在 DOM 里：既看不到「当前」标记，也没法从附近
   * 往下跳。这里至少挂到当前章，再多给一批旧章；后续仍按 sentinel 继续补。
   */
  useEffect(() => {
    if (!chapters) return;
    const target = currentPos < 0 ? BATCH : Math.min(ordered.length, currentPos + BATCH);
    setLimit((n) => Math.max(n, target));
  }, [chapters, ordered.length, currentPos]);

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

  /*
   * 打开目录时把当前章滚到中间。
   *
   * 只在「这本书/这一章」第一次定位时做一次；后续 sentinel 追加旧章会让
   * visible 变化，如果每次都重新居中，用户刚往下滑就被拽回当前章。
   */
  const positionedFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!loaded || !chapters || currentPos < 0) return;
    const key = `${pluginId}/${slug}/${currentId}`;
    if (positionedFor.current === key) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('.drawer__item.on');
    if (!list || !row) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const delta = rowRect.top - listRect.top - (list.clientHeight - rowRect.height) / 2;
    list.scrollTop = Math.max(0, list.scrollTop + delta);
    positionedFor.current = key;
  }, [loaded, chapters, currentPos, pluginId, slug, currentId, limit]);

  /*
   * 目录打开后先猜一次：定位到当前章以后，离它最近的那一行往往就是用户要去的
   * 下一站。滚动停稳时再猜一次（onScroll），两次都走 450ms 防抖。
   */
  useEffect(() => {
    if (!loaded) return;
    onPrefetchNearest?.(listRef.current);
  }, [loaded, onPrefetchNearest]);

  /* 关目录时把还没到点的"猜下一章"取消掉，别在用户已经回到正文后再跑一趟 */
  useEffect(() => () => onPrefetchNearest?.(null), [onPrefetchNearest]);

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
          <div
            className="drawer__list"
            ref={listRef}
            onScroll={() => onPrefetchNearest?.(listRef.current)}
          >
            {visible.map((c, i) => {
              const marks = bookmarks.get(c.id);
              return (
                <button
                  key={c.id}
                  data-chapter-id={c.id}
                  className={`drawer__item${c.id === currentId ? ' on' : ''}${
                    isRead(positions[c.id]) ? ' drawer__item--read' : ''
                  }`}
                  onPointerEnter={() => onPrefetchHover?.(c.id)}
                  onPointerDown={() => onPrefetchChapter?.(c.id)}
                  onFocus={() => onPrefetchChapter?.(c.id)}
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
