import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getChapter, getComic, coverUrl, type Chapter, type Comic } from '@/site/engine';
import {
  addToShelf,
  cacheChapterImages,
  deleteCachedBySiteAndSlug,
  formatBytes,
  getCachedChapter,
  isInShelf,
  listCachedChapters,
  removeFromShelf,
} from '@/store/db';
import { useSite } from '@/store/SiteContext';
import { IconBack, IconCheck, IconDownload, IconSettings, IconShelf } from '@/components/Icons';
import { ErrorBox, Loading, Sheet } from '@/components/UI';

type CachedMap = Record<string, { bytes: number }>;

export default function ComicPage() {
  const { slug = '' } = useParams();
  const nav = useNavigate();
  const { site } = useSite();

  const [comic, setComic] = useState<Comic | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [onShelf, setOnShelf] = useState(false);
  const [cached, setCached] = useState<CachedMap>({});
  const [caching, setCaching] = useState<{ done: number; total: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(async () => {
    if (!site) return;
    setErr(null);
    try {
      const [{ comic: c, chapters: ch }, inShelf, cacheList] = await Promise.all([
        getComic(site, slug),
        isInShelf(site.id, slug),
        listCachedChapters(site.id, slug),
      ]);
      setComic(c);
      setChapters(ch);
      setOnShelf(inShelf);
      const map: CachedMap = {};
      for (const item of cacheList) map[item.chapterId] = { bytes: item.bytes };
      setCached(map);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [site, slug]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleShelf = async () => {
    if (!site || !comic) return;
    if (onShelf) {
      await removeFromShelf(site.id, slug);
      setOnShelf(false);
    } else {
      await addToShelf(site.id, { slug, title: comic.title, cover: comic.cover });
      setOnShelf(true);
    }
  };

  /** 离线下载整部：逐章抓取并缓存 */
  const cacheAll = async () => {
    if (!site) return;
    const targets = chapters.filter((c) => !cached[c.id]);
    if (targets.length === 0) {
      alert('所有章节都已缓存');
      return;
    }
    if (!confirm(`将下载 ${targets.length} 章到本机离线存储，可能占用较多空间。继续？`)) return;

    const total = targets.length;
    setCaching({ done: 0, total });

    for (let i = 0; i < targets.length; i++) {
      const ch = targets[i];
      try {
        const existing = await getCachedChapter(site.id, slug, ch.id);
        const images = existing?.images ?? (await getChapter(site, slug, ch.id)).images;
        const bytes = await cacheChapterImages(site.id, slug, ch.id, images, (p) =>
          setCaching({ done: i + p.done / p.total, total }),
        );
        setCached((m) => ({ ...m, [ch.id]: { bytes } }));
      } catch (e) {
        console.error(`缓存 ${ch.id} 失败`, e);
      }
    }

    setCaching(null);
    alert('下载完成');
  };

  const cachedBytes = Object.values(cached).reduce((s, v) => s + v.bytes, 0);

  if (!site) {
    return (
      <>
        <header className="topbar">
          <div className="topbar__title">未配置站点</div>
        </header>
        <div className="empty">
          <div>还没有可用的内容源</div>
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
                  {comic.tags?.map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                  <span className="tag">{chapters.length} 章</span>
                </div>
                {comic.description && <p className="detail__desc">{comic.description}</p>}

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn" onClick={toggleShelf}>
                    {onShelf ? <IconCheck size={16} /> : <IconShelf size={16} />}
                    {onShelf ? '已在书架' : '加入书架'}
                  </button>
                  <button className="btn btn--ghost" onClick={cacheAll} disabled={!!caching}>
                    <IconDownload size={16} />
                    {caching
                      ? `下载中 ${Math.floor(caching.done)}/${caching.total}`
                      : '离线下载'}
                  </button>
                </div>

                {cachedBytes > 0 && (
                  <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-faint)' }}>
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

            <div>
              <div className="section-head">
                <h2>章节</h2>
                <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                  共 {chapters.length} 章
                </span>
              </div>
              <div className="chapters">
                {chapters.map((ch) => {
                  const isCached = cached[ch.id];
                  return (
                    <Link key={ch.id} to={`/read/${ch.id}`} className="chapter-row">
                      <span className="chapter-row__name">{ch.title}</span>
                      {isCached && (
                        <span className="chapter-row__badge badge-cache">
                          离线 {formatBytes(isCached.bytes)}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </main>

      {showSettings && comic && (
        <Sheet title="阅读设置" onClose={() => setShowSettings(false)}>
          <div className="opt-row">
            <div>
              <div className="opt-row__label">当前站点</div>
              <div className="opt-row__hint">{site.name}</div>
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
                if (confirm(`移除《${comic.title}》并清除其离线缓存？`)) {
                  await deleteCachedBySiteAndSlug(site.id, slug);
                  await removeFromShelf(site.id, slug);
                  nav('/shelf');
                }
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
