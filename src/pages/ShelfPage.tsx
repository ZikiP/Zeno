import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getShelf, type ShelfEntry } from '@/store/db';
import { IconEmpty, IconExplore, IconShelf } from '@/components/Icons';
import { ComicGrid, ErrorBox, Loading } from '@/components/UI';

export default function ShelfPage() {
  const [items, setItems] = useState<ShelfEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setErr(null);
    getShelf().then(setItems).catch((e) => setErr((e as Error).message));
  };

  useEffect(load, []);

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
        ) : items === null ? (
          <Loading text="读取书架" />
        ) : items.length === 0 ? (
          <div className="empty">
            <IconEmpty />
            <div>书架还是空的</div>
            <Link to="/explore" className="btn btn--sm" style={{ marginTop: 6 }}>
              <IconExplore size={16} />
              去发现漫画
            </Link>
          </div>
        ) : (
          <ComicGrid comics={items.map((i) => i.comic)} />
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
      </nav>
    </>
  );
}
