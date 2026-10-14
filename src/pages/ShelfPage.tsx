import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getShelf } from '@/store/shelf';
import type { ShelfEntry } from '@/store/types';
import { usePlugin } from '@/store/PluginContext';
import { coverUrl } from '@/site/engine';
import { IconEmpty, IconExplore, IconSearch, IconSettings, IconShelf } from '@/components/Icons';
import { ErrorBox, Loading } from '@/components/UI';

export default function ShelfPage() {
  const { plugin } = usePlugin();
  const [items, setItems] = useState<ShelfEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setItems(await getShelf(plugin?.meta.id));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [plugin?.meta.id]);

  useEffect(() => {
    load();
  }, [load]);

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
            {items.map((it) => (
              <Link key={it.key} to={`/comic/${it.slug}`} className="card">
                <div className="card__cover">
                  {it.cover && plugin && (
                    <img
                      src={coverUrl(it.cover, 300, 400)}
                      alt={it.title}
                      loading="lazy"
                      decoding="async"
                    />
                  )}
                </div>
                <div className="card__name">{it.title}</div>
              </Link>
            ))}
          </div>
        )}
      </main>

      <nav className="bottom-nav">
        <Link to="/shelf" className="active">
          <IconShelf />
          书架
        </Link>
        <Link to="/explore">
          <IconExplore />
          发现
        </Link>
        <Link to="/search">
          <IconSearch size={20} />
          搜索
        </Link>
        <Link to="/settings">
          <IconSettings />
          设置
        </Link>
      </nav>
    </>
  );
}
