import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useVtNavigate } from '@/hooks/viewTransition';
import { getComic, coverUrl, type Chapter, type Comic } from '@/site/engine';
import { cacheChapterList } from '@/store/chapters';
import { addToShelf, bookProgress, getShelfEntry, removeFromShelf } from '@/store/shelf';
import type { ShelfEntry } from '@/store/types';
import { formatBytes } from '@/store/utils';
import { useOfflineCache } from '@/store/useOfflineCache';
import { usePlugin } from '@/store/PluginContext';
import { onDataChange } from '@/store/dataEvents';
import ChapterList from '@/components/ChapterList';
import ProgressRing from '@/components/ProgressRing';
import {
  IconBack,
  IconCheck,
  IconDownload,
  IconPlay,
  IconSettings,
  IconShelf,
} from '@/components/Icons';
import { ErrorBox, Loading, Sheet } from '@/components/UI';

export default function ComicPage() {
  const { slug = '' } = useParams();
  const nav = useVtNavigate();
  const { plugin } = usePlugin();

  const [comic, setComic] = useState<Comic | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [err, setErr] = useState<string | null>(null);
  /** 书架记录本身，不只是"在不在架"—— 继续阅读和进度提示都要用它 */
  const [entry, setEntry] = useState<ShelfEntry | undefined>(undefined);
  const [showSettings, setShowSettings] = useState(false);

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

  const load = useCallback(async () => {
    if (!plugin?.meta.id) return;
    setErr(null);
    try {
      const [c, e] = await Promise.all([
        getComic(plugin, slug),
        getShelfEntry(plugin.meta.id, slug),
      ]);
      setComic(c.comic);
      setChapters(c.chapters);
      setEntry(e);

      // 顺手缓存章节表，阅读器内打开目录就不用再抓一次
      void cacheChapterList(
        plugin.meta.id,
        slug,
        c.comic.title,
        c.chapters.map((x) => ({ id: x.id, index: x.index, title: x.title })),
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [plugin, slug]);

  useEffect(() => {
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
      await addToShelf(plugin.meta.id, { slug, title: comic.title, cover: comic.cover });
      setEntry(await getShelfEntry(plugin.meta.id, slug));
    }
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
        <button className="icon-btn" onClick={() => nav(-1)} aria-label="返回">
          <IconBack />
        </button>
        <div className="topbar__title">{comic?.title ?? '加载中'}</div>
        <div className="topbar__spacer" />
        <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="设置">
          <IconSettings />
        </button>
      </header>

      <main className="main">
        {err ? (
          <ErrorBox message={err} onRetry={load} />
        ) : !comic ? (
          <Loading text="抓取漫画信息" />
        ) : (
          <div className="detail">
            <div className="detail__head">
              <img className="detail__cover" src={coverUrl(comic.cover, 400, 530)} alt={comic.title} />
              <div>
                <h1 className="detail__title">{comic.title}</h1>
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
                    {onShelf ? <IconCheck size={16} /> : <IconShelf size={16} />}
                    {onShelf ? '已在书架' : '加入书架'}
                  </button>
                  <button className="btn btn--ghost" onClick={cacheAll} disabled={!!caching}>
                    <IconDownload size={16} />
                    {caching ? `下载中 ${Math.floor(caching.done)}/${caching.total}` : '离线下载'}
                  </button>
                </div>

                {cachedBytes > 0 && (
                  <div className="detail__cached">
                    已离线 {Object.keys(cached).length} 章 · {formatBytes(cachedBytes)}
                  </div>
                )}
              </div>
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
            />
          </div>
        )}
      </main>

      {showSettings && comic && (
        <Sheet title="阅读设置" onClose={() => setShowSettings(false)}>
          <div className="opt-row">
            <div>
              <div className="opt-row__label">当前插件</div>
              <div className="opt-row__hint">{plugin.meta.name}</div>
            </div>
            <Link to="/settings" className="btn btn--ghost btn--sm">
              切换
            </Link>
          </div>
          <div className="opt-row">
            <div>
              <div className="opt-row__label">从书架移除</div>
              <div className="opt-row__hint">同时清除该漫画的离线缓存</div>
            </div>
            <button
              className="btn btn--ghost btn--sm"
              onClick={async () => {
                if (await dropEverything(comic.title)) nav('/shelf');
              }}
            >
              移除
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
