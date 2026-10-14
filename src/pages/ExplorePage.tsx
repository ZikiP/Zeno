import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listComics, CATEGORIES, type Comic } from '@/site/twmanga';
import { IconExplore, IconSearch, IconShelf } from '@/components/Icons';
import { ComicGrid, ErrorBox, Loading } from '@/components/UI';

type Filter = { type: string; region: string; state: string };

export default function ExplorePage() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [filter, setFilter] = useState<Filter>({ type: 'all', region: 'all', state: 'all' });
  const [comics, setComics] = useState<Comic[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const list = submitted
        ? await listComics({ query: submitted })
        : await listComics(filter);
      setComics(list);
    } catch (e) {
      setErr((e as Error).message);
      setComics([]);
    } finally {
      setLoading(false);
    }
  }, [submitted, filter]);

  useEffect(() => {
    load();
  }, [load]);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(q.trim());
  };

  return (
    <>
      <header className="topbar">
        <form className="search" onSubmit={onSearch}>
          <IconSearch size={17} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索漫画"
            enterKeyHint="search"
          />
          {submitted && (
            <button
              type="button"
              style={{ color: 'var(--text-faint)', fontSize: 12 }}
              onClick={() => {
                setQ('');
                setSubmitted('');
              }}
            >
              清除
            </button>
          )}
        </form>
      </header>

      {!submitted && (
        <div className="filters">
          <span style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: '30px' }}>
            题材
          </span>
          {CATEGORIES.type.map((c) => (
            <button
              key={c.key}
              className={`chip${filter.type === c.key ? ' on' : ''}`}
              onClick={() => setFilter((f) => ({ ...f, type: c.key }))}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {!submitted && (
        <div className="filters">
          <span style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: '30px' }}>
            地区
          </span>
          {CATEGORIES.region.map((c) => (
            <button
              key={c.key}
              className={`chip${filter.region === c.key ? ' on' : ''}`}
              onClick={() => setFilter((f) => ({ ...f, region: c.key }))}
            >
              {c.label}
            </button>
          ))}
          <span
            style={{
              width: 1,
              background: 'var(--border)',
              margin: '4px 4px',
              flexShrink: 0,
            }}
          />
          {CATEGORIES.state.map((c) => (
            <button
              key={c.key}
              className={`chip${filter.state === c.key ? ' on' : ''}`}
              onClick={() => setFilter((f) => ({ ...f, state: c.key }))}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {submitted && (
        <div
          style={{
            padding: '8px 12px',
            fontSize: 12,
            color: 'var(--text-faint)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          搜索「{submitted}」{comics ? ` · ${comics.length} 个结果` : ''}
        </div>
      )}

      <main className="main">
        {err ? (
          <ErrorBox message={err} onRetry={load} />
        ) : loading && comics === null ? (
          <Loading text="抓取中" />
        ) : (
          <ComicGrid comics={comics ?? []} />
        )}
      </main>

      <nav className="bottom-nav">
        <Link to="/shelf">
          <IconShelf />
          书架
        </Link>
        <Link to="/explore" className="active">
          <IconExplore />
          发现
        </Link>
      </nav>
    </>
  );
}
