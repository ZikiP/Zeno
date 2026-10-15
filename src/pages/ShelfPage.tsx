import { useCallback, useMemo, useState } from 'react';
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
  const { enabled, loading } = usePlugin();
  const [items, setItems] = useState<ShelfEntry[] | null>(null);
  /** 章节表缓存，按 `${pluginId}/${slug}` 索引，全书进度要用 */
  const [lists, setLists] = useState<Record<string, { id: string; index: number }[]>>({});
  const [err, setErr] = useState<string | null>(null);

  /*
   * 书架跨所有已启用的源，不再只看"当前那一个"。
   * 封面得按每一本自己的源取规则：包子漫画的封面参数和拷貝漫畫的不是一回事，
   * 拿错插件等于用另一套 {w}/{h} 模板去拼 URL。
   * 源被停用后它的书只是从书架上藏起来，记录还在 —— 重新启用就回来。
   */
  const byId = useMemo(
    () => Object.fromEntries(enabled.map((p) => [p.meta.id, p])),
    [enabled],
  );

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [shelf, cached] = await Promise.all([getShelf(), getCachedChapterLists()]);
      setItems(shelf.filter((e) => byId[e.pluginId]));
      setLists(Object.fromEntries(cached.map((c) => [c.key, c.chapters])));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [byId]);

  // 同步写完本地库后自动重读，不用手动刷新页面
  useReloadOnChange(load);

  return (
    <>
      <header className="topbar">
        <div className="topbar__title">
          我的书架{items && items.length > 0 ? ` (${items.length})` : ''}
        </div>
        <div className="topbar__spacer" />
      </header>

      <main className="main">
        {err ? (
          <ErrorBox message={err} onRetry={load} />
        ) : items === null || loading ? (
          <Loading text="读取书架" />
        ) : items.length === 0 ? (
          <div className="empty">
            <IconEmpty />
            <div>书架还是空的</div>
            {enabled.length > 0 ? (
              <Link to="/explore" className="btn btn--sm" style={{ marginTop: 6 }}>
                <IconExplore size={16} />
                去发现漫画
              </Link>
            ) : (
              <Link to="/settings?tab=sources" className="btn btn--sm" style={{ marginTop: 6 }}>
                <IconSettings size={16} />
                先启用一个内容源
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
              const source = byId[it.pluginId];
              return (
                <Link
                  key={it.key}
                  to={`/comic/${it.pluginId}/${it.slug}`}
                  className="card card--plate"
                >
                  <div className="card__cover">
                    {it.cover && source && (
                      <img
                        src={coverUrl(source, it.cover, 300, 400)}
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
