import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useBackToHome } from '@/hooks/useBackToHome';
import { getComic, chapterUrl, coverUrl, type Chapter, type Comic } from '@/site/engine';
import { displayComicTitle } from '@/site/title';
import { cacheChapterList, getChapterList } from '@/store/chapters';
import { useChapterPrefetch } from '@/hooks/useChapterPrefetch';
import { reportSeen } from '@/store/updates';
import { addToShelf, bookProgress, getShelfEntry, markThrough, removeFromShelf } from '@/store/shelf';
import type { ShelfEntry } from '@/store/types';
import { formatBytes } from '@/store/utils';
import { useOfflineCache } from '@/store/useOfflineCache';
import { useWarmFollow } from '@/store/useWarmFollow';
import { usePlugin } from '@/store/PluginContext';
import { onDataChange } from '@/store/dataEvents';
import ChapterList from '@/components/ChapterList';
import ComicSheet from '@/components/ComicSheet';
import ProgressRing from '@/components/ProgressRing';
import ShelfStateIcon from '@/components/ShelfStateIcon';
import {
  IconBack,
  IconDownload,
  IconHeart,
  IconPlay,
  IconSettings,
} from '@/components/Icons';
import { ErrorBox } from '@/components/UI';

export default function ComicPage() {
  const { slug = '' } = useParams();
  const nav = useNavigate();
  const back = useBackToHome();
  const { plugin } = usePlugin();

  const [comic, setComic] = useState<Comic | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [err, setErr] = useState<string | null>(null);
  /** 书架记录本身，不只是"在不在架"—— 继续阅读和进度提示都要用它 */
  const [entry, setEntry] = useState<ShelfEntry | undefined>(undefined);
  const [showSettings, setShowSettings] = useState(false);
  /**
   * 这一本是不是已经拿到过"真"内容。
   * 本地恢复那条路要靠它刹车：抓取先回来的话，缓存那份就绝不能再盖回去。
   */
  const fresh = useRef(false);

  const onShelf = !!entry;
  const lastChapter = chapters.find((c) => c.id === entry?.lastChapterId);
  const lastPct = entry?.lastChapterId ? (entry.positions[entry.lastChapterId] ?? 0) : 0;
  /** 全书完成度，书架卡片上的环用的是同一个算法 */
  const bookPct = entry ? bookProgress(chapters, entry) : null;

  const { cached, caching, cachedBytes, cacheAll, dropEverything } = useOfflineCache(
    plugin,
    slug,
    chapters,
  );

  /* 追漫：开关与"哪几章已经缓存好"的标记。铺字节是服务端的事，这一层只切开关 */
  const follow = useWarmFollow({ plugin, slug, title: comic?.title });
  const warmCached = Object.values(follow.marks).filter((m) => m.cached).length;

  /**
   * 提前把地址表拿回来。
   *
   * 阅读器真正的大头等待不是图片，而是这一章的两三次上游请求（实测 2–5 秒）。
   * 详情页本来就要停留一会儿：继续阅读按 idle/悬停/按下预热，目录里悬停或滚动
   * 停稳时预热指针附近那一章，阅读器打开时 useChapterLoader 直接命中 IndexedDB。
   * 共享的 prefetchChapterTable 会和阅读器的请求去重，点得太快也只会跑一趟。
   */
  const chapterPrefetch = useChapterPrefetch(plugin, slug, entry?.lastChapterId ?? null);

  useEffect(() => {
    const id = entry?.lastChapterId;
    if (!id) return;
    const timer = window.setTimeout(() => chapterPrefetch.prefetch(id), 900);
    return () => window.clearTimeout(timer);
  }, [entry?.lastChapterId, chapterPrefetch.prefetch]);

  /* 目录是整页滚动的：停稳后猜视口中央那一章，具体防抖在 hook 里 */
  useEffect(() => {
    const onScroll = () => chapterPrefetch.prefetchNearest(document);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [chapterPrefetch.prefetchNearest]);

  /*
   * 抓的是"哪个源的哪本书"，不是插件对象的那个身份。
   *
   * PluginContext 每 reload 一次就 listPlugins() 重读一遍 IndexedDB，
   * 那份 JSON 是现 parse 的，对象身份必然跟着变；而一次进这个页面，
   * 挂载、同步推完、同步拉完至少会 reload 几轮（每轮都发一次数据变更）。
   * `load` 以前依赖整个 plugin 对象，于是同一本书被从头抓三遍
   * —— 实测一次打开详情页是 3 个详情页的文档请求，而渲染槽一共才 3 格。
   *
   * 抓取规则还是要用最新那份对象，所以它放 ref 里现读，依赖只留 id 与 slug。
   */
  const livePlugin = useRef(plugin);
  useEffect(() => {
    livePlugin.current = plugin;
  });

  /** 第几次 load。换书换源时，上一次的结果不该再写回来 */
  const seq = useRef(0);

  const load = useCallback(async () => {
    const p = livePlugin.current;
    if (!p?.meta.id) return;
    const mine = ++seq.current;
    const pluginId = p.meta.id;
    setErr(null);
    /*
     * 「读到哪了」单独取，别跟着详情页一起等。
     *
     * getShelfEntry 是本地 IndexedDB，几毫秒；getComic 是一次服务端渲染，
     * 会话还在 0.8s、会话没了 8s+。以前两个捆在 Promise.all 里一起 set，
     * 于是缓存那半（封面、简介、目录）先画好，进度环和「继续阅读」要等网络那半
     * 才凭空冒出来 —— 同一块版面分两次长齐，看着就是割裂。
     * 捆在一起还有第二个代价：抓取一抽风 Promise.all 整个 reject，
     * 本地明明有的那条进度也跟着没了。
     */
    void getShelfEntry(pluginId, slug).then(
      (e) => mine === seq.current && setEntry(e),
      () => {},
    );
    try {
      const c = await getComic(p, slug);
      if (mine !== seq.current) return;
      // 真内容到手，本地那份就再不该盖回来（见下面那个恢复用的 effect）
      fresh.current = true;
      setComic(c.comic);
      setChapters(c.chapters);

      // 顺手缓存章节表，阅读器内打开目录就不用再抓一次
      void cacheChapterList(pluginId, slug, c.comic, c.chapters.map((x) => ({ id: x.id, index: x.index, title: x.title })));
      /*
       * 追更徽章在这里清零：把"我现在知道有几章"报回服务端去对齐基线。
       * 报的是解析出来的条数，跟服务端那边数的单位是同一个口径（有测试钉着），
       * 少这一步的话徽章会一直挂着，看起来像"永远有新章"。
       */
      void reportSeen(`${pluginId}/${slug}`, c.chapters.length).catch(() => {});
    } catch (e) {
      /*
       * 已经有内容（不管是刚抓到的还是从本地恢复的）就别把整页换成错误框：
       * 站点抽风的时侯，用户手上的目录和"上次读到第几章"都还在，
       * 一句报错把它们全藏起来，等于把"看不了"扩大成"什么都没了"。
       */
      setErr((e as Error).message);
    }
  }, [plugin?.meta.id, slug]);

  /*
   * 先用本地那份画出来，再去抓。
   *
   * 为什么值得专门做这件事：详情页的主体是被 `!comic` 挡住的，而抓详情页要一次
   * 服务端渲染（实测会话还在 0.8s、会话没了 8s+）。同一本书翻来覆去看，
   * 每一次都要重新付这笔，而答案明明就在设备的库里躺着。
   *
   * 只恢复展示字段和目录，不恢复"读到第几章"—— 那是 entry 的事，
   * 它本来就走 IndexedDB，快得很。
   */
  useEffect(() => {
    if (!plugin?.meta.id) return;
    let dropped = false;
    void (async () => {
      const cached = await getChapterList(plugin.meta.id!, slug);
      if (dropped || fresh.current || !cached?.comic) return;
      setComic(cached.comic);
      setChapters(
        cached.chapters.map((c) => ({ ...c, url: chapterUrl(plugin, slug, c.id) })),
      );
    })();
    return () => {
      dropped = true;
    };
  }, [plugin, slug]);

  useEffect(() => {
    fresh.current = false;
    void load();
  }, [load]);

  /*
   * 同步把别处的「加入书架 / 阅读进度」变更拉回来时刷新。
   * 离线缓存那一侧由 useOfflineCache 自己订阅同一个事件，两边互不影响。
   */
  useEffect(() => {
    if (!plugin?.meta.id) return;
    return onDataChange(async () => {
      setEntry(await getShelfEntry(plugin.meta.id, slug));
    });
  }, [plugin?.meta.id, slug]);

  const toggleShelf = async () => {
    if (!plugin || !comic) return;
    if (onShelf) {
      await removeFromShelf(plugin.meta.id, slug);
      setEntry(undefined);
    } else {
      await addToShelf(plugin.meta.id, {
        slug,
        title: displayComicTitle(comic.title, plugin.meta.name),
        cover: comic.cover,
      });
      setEntry(await getShelfEntry(plugin.meta.id, slug));
    }
  };

  /**
   * 一键标 / 取消「这一章之前」为已读。
   *
   * 依据是 chapters 的 id 序列 —— 它是升序（阅读顺序）。
   * 列表切成正序还是倒序只是「怎么看」，不该改变「之前」是谁。
   */
  const markThroughHere = async (uptoId: string, read: boolean) => {
    if (!plugin || !entry) return;
    await markThrough(plugin.meta.id, slug, chapters.map((c) => c.id), uptoId, read);
    setEntry(await getShelfEntry(plugin.meta.id, slug));
  };

  if (!plugin) {
    return (
      <>
        <header className="topbar">
          <div className="topbar__title">未配置站点</div>
        </header>
        <div className="empty">
          <div>还没有已安装的插件</div>
          <Link to="/settings" className="btn btn--sm">
            去添加站点
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <header className="topbar">
        <button className="icon-btn" onClick={back} aria-label="返回">
          <IconBack />
        </button>
        <div className="topbar__title">
          {comic ? displayComicTitle(comic.title, plugin.meta.name) : '加载中'}
        </div>
        <div className="topbar__spacer" />
        <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="设置">
          <IconSettings />
        </button>
      </header>

      <main className="main">
        {err && (
          <ErrorBox message={comic ? '刷新没成功，下面这份是上次抓到的' : err} onRetry={load} />
        )}
        {!comic && !err && <DetailSkeleton />}
        {comic && (
          <div className="detail">
            <div className="detail__head">
              <img
                className="detail__cover"
                src={coverUrl(plugin, comic.cover, 400, 530)}
                alt={displayComicTitle(comic.title, plugin.meta.name)}
              />
              {/*
               * 书名/标签单独一层：手机上它要贴在封面右边，
               * 简介、进度和按钮则整行铺开 —— 全塞在同一个 div 里的话，
               * grid 没法只把其中几项拉通整行。
               */}
              <div className="detail__intro">
                <h1 className="detail__title">{displayComicTitle(comic.title, plugin.meta.name)}</h1>
                <div className="detail__meta">
                  {comic.finished !== undefined && (
                    <span className="tag">{comic.finished ? '已完结' : '连载中'}</span>
                  )}
                  {comic.tags?.map((t, i) => (
                    <span className="tag" key={`${t}-${i}`}>
                      {t}
                    </span>
                  ))}
                  <span className="tag">{chapters.length} 章</span>
                </div>
              </div>

              {comic.description && <p className="detail__desc">{comic.description}</p>}

              {lastChapter && (
                <div className="detail__reading">
                  {/* 环上是全书完成度，跟书架那张卡同一个口径；
                      文字里另说本章读到几成，两个数不是一回事。
                      lastChapter 就是从 chapters 里找到的，所以这里算得出 */}
                  <ProgressRing percent={bookPct ?? 0} size={22} label={`全书 ${bookPct ?? 0}%`} />
                  <span className="detail__reading-text">
                    上次读到 {lastChapter.title}
                    {lastPct > 0 ? ` · 本章 ${lastPct}%` : ''}
                    {bookPct !== null ? ` · 全书 ${bookPct}%` : ''}
                  </span>
                </div>
              )}

              <div className="detail__actions">
                {entry?.lastChapterId && (
                  <button
                    className="btn"
                    onPointerEnter={() => {
                      const id = entry?.lastChapterId;
                      if (id) chapterPrefetch.prefetch(id);
                    }}
                    onPointerDown={() => {
                      const id = entry?.lastChapterId;
                      if (id) chapterPrefetch.prefetch(id);
                    }}
                    onClick={() => nav(`/read/${plugin.meta.id}/${slug}/${entry.lastChapterId}`)}
                  >
                    <IconPlay size={16} />
                    继续阅读
                  </button>
                )}
                <button
                  className={entry?.lastChapterId ? 'btn btn--ghost' : 'btn'}
                  onClick={toggleShelf}
                >
                  <ShelfStateIcon on={onShelf} size={16} />
                  {onShelf ? '已在书架' : '加入书架'}
                </button>
                <button className="btn btn--ghost" onClick={cacheAll} disabled={!!caching}>
                  <IconDownload size={16} />
                  {caching ? `下载中 ${Math.floor(caching.done)}/${caching.total}` : '离线下载'}
                </button>
                {/*
                 * 追漫跟在架才给：服务端算"该铺哪几章"要同时认两样 ——
                 * 在不在架上、这本开没开追漫。不在架时开关写了也没人去读，
                 * 摆一颗点了没反应的按钮更糟。
                 */}
                {entry && (
                  <button className="btn btn--ghost" onClick={() => follow.setWarmFollow(!follow.warm)}>
                    <IconHeart size={16} filled={!!follow.warm} />
                    {follow.warm ? '已追漫' : '追漫'}
                  </button>
                )}
              </div>

              {cachedBytes > 0 && (
                <div className="detail__cached">
                  已离线 {Object.keys(cached).length} 章 · {formatBytes(cachedBytes)}
                </div>
              )}
              {/*
               * 说出"最近 K 章"这个口径：不然用户看到"已缓存 2 章"而书架上有
               * 几百章未读，第一反应是这功能坏了（实际是窗口就这么定的）。
               */}
              {follow.warm && warmCached > 0 && (
                <div className="detail__cached">
                  追漫 · 已缓存 {warmCached} 章（未读的最近 {follow.keep} 章）
                </div>
              )}
            </div>

            {caching && (
              <div className="progress">
                <div
                  className="progress__bar"
                  style={{ width: `${(caching.done / caching.total) * 100}%` }}
                />
              </div>
            )}

            <ChapterList
              chapters={chapters}
              pluginId={plugin.meta.id}
              slug={slug}
              cached={cached}
              warm={follow.marks}
              positions={entry?.positions}
              /* 不悬停也不点的章节不动它；滚动停稳后的猜测由页面这层接 */
              onPrefetchChapter={chapterPrefetch.prefetch}
              onPrefetchHover={chapterPrefetch.prefetchHover}
              /* 不在书架上没有进度可记，那颗批量按钮也就没意义 */
              onMarkThrough={entry ? markThroughHere : undefined}
            />
          </div>
        )}
      </main>

      {showSettings && comic && (
        <ComicSheet
          sourceName={plugin.meta.name}
          onClose={() => setShowSettings(false)}
          onRemove={async (): Promise<boolean> => {
            const gone = await dropEverything(comic.title);
            if (gone) nav('/shelf');
            return gone;
          }}
        />
      )}
    </>
  );
}

/**
 * 抓详情时的占位。
 *
 * 服务端要真跑一次浏览器渲染（会话冷时 2–6 秒），只放一句「抓取漫画信息」
 * 会让整页空着；骨架先把封面和文字的位置占住，内容回来时就不会跳。
 */
function DetailSkeleton() {
  return (
    <div
      className="detail detail--skeleton"
      aria-busy="true"
      aria-label="正在抓取漫画信息"
    >
      <div className="detail__head">
        <div className="detail__cover skeleton" />
        <div className="detail__intro">
          <div className="skeleton sk-line sk-line--title" />
          <div className="sk-tags">
            <span className="skeleton sk-tag" />
            <span className="skeleton sk-tag" />
            <span className="skeleton sk-tag" />
          </div>
        </div>
        <div className="skeleton sk-desc" />
        <div className="skeleton sk-actions" />
      </div>
      <div className="skeleton sk-list" />
    </div>
  );
}
