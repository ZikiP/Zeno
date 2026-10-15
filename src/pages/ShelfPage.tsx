import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { getShelf, bookProgress } from '@/store/shelf';
import { getCachedChapterLists } from '@/store/chapters';
import type { ShelfEntry } from '@/store/types';
import { usePlugin } from '@/store/PluginContext';
import { useReloadOnChange } from '@/store/useDataVersion';
import { coverUrl } from '@/site/engine';
import { IconEmpty, IconExplore, IconSettings } from '@/components/Icons';
import BottomNav from '@/components/BottomNav';
import ProgressRing from '@/components/ProgressRing';
import { ErrorBox, Loading } from '@/components/UI';

export default function ShelfPage() {
  const { plugin } = usePlugin();
  const [items, setItems] = useState<ShelfEntry[] | null>(null);
  /** 章节表缓存，按 `${pluginId}/${slug}` 索引，全书进度要用 */
  const [lists, setLists] = useState<Record<string, { id: string; index: number }[]>>({});
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [shelf, cached] = await Promise.all([
        getShelf(plugin?.meta.id),
        getCachedChapterLists(plugin?.meta.id),
      ]);
      setItems(shelf);
      setLists(Object.fromEntries(cached.map((c) => [c.key, c.chapters])));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [plugin?.meta.id]);

  // 同步写完本地库后自动重读，不用手动刷新页面
  useReloadOnChange(load);

  return (
    <>
      <header className="topbar">
        <div className="topbar__title">
          我的书架{items && items.length > 0 ? ` (${items.length})` : ''}
        </div>
        <div className="topbar__spacer" />
        {plugin && (
          <span style={{ fontSize: 12, color: 'var(--text-faint)', paddingRight: 8 }}>
            {plugin.meta.name}
          </span>
        )}
      </header>

      <main className="main">
        {err ? (
          <ErrorBox message={err} onRetry={load} />
        ) : items === null ? (
          <Loading text="读取书架" />
        ) : items.length === 0 ? (
          <div className="empty">
            <IconEmpty />
            <div>书架还是空的</div>
            {plugin ? (
              <Link to="/explore" className="btn btn--sm" style={{ marginTop: 6 }}>
                <IconExplore size={16} />
                去发现漫画
              </Link>
            ) : (
              <Link to="/settings" className="btn btn--sm" style={{ marginTop: 6 }}>
                <IconSettings size={16} />
                先添加一个站点
              </Link>
            )}
          </div>
        ) : (
          <div className="grid">
            {items.map((it) => {
              /*
               * 全书进度 =（读到第几章 + 本章读到几成）/ 总章数。
               * 以前直接拿"最近一章读到几成"当进度，等于把本章进度条
               * 缩小一圈摆在封面上：200 话读到第 12 话明明是 6%，环上显示 42%。
               * 算不出来（章节表没缓存、或那章已从表里掉了）就不画 ——
               * 环上没有数字，画错了用户看不出来，宁缺。
               */
              const pct = bookProgress(lists[it.key], it);
              return (
                <Link
                  key={it.key}
                  to={`/comic/${it.pluginId}/${it.slug}`}
                  className="card card--plate"
                >
                  <div className="card__cover">
                    {it.cover && plugin && (
                      <img
                        src={coverUrl(plugin, it.cover, 300, 400)}
                        alt={it.title}
                        loading="lazy"
                        decoding="async"
                      />
                    )}
                    {pct !== null && pct > 0 && (
                      <ProgressRing percent={pct} size={30} label={`全书 ${pct}%`} />
                    )}
                  </div>
                  <div className="card__name">{it.title}</div>
                </Link>
              );
            })}
          </div>
        )}
      </main>

      <BottomNav />
    </>
  );
}
