import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listComics, coverUrl, type Comic } from '@/site/engine';
import { usePlugin } from '@/store/PluginContext';
import { IconEmpty, IconExplore, IconSearch, IconSettings, IconShelf } from '@/components/Icons';
import { ErrorBox, Loading } from '@/components/UI';

/**
 * 分类维度。这些值会填进站点配置的 URL 模板变量，
 * 所以是否有效取决于目标站点支持哪些取值 —— 不支持时列表会返回空。
 * 用户可以直接在站点配置里改 URL 模板来匹配自己站点的实际参数。
 */
const REGIONS = [
  { key: 'all', label: '全部' },
  { key: 'cn', label: '国漫' },
  { key: 'jp', label: '日本' },
  { key: 'kr', label: '韩国' },
  { key: 'en', label: '欧美' },
];

const STATES = [
  { key: 'all', label: '全部' },
  { key: 'serial', label: '连载中' },
  { key: 'pub', label: '已完结' },
];

export default function ExplorePage() {
  const { plugin } = usePlugin();
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [region, setRegion] = useState('all');
  const [state, setState] = useState('all');
  const [comics, setComics] = useState<Comic[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!plugin?.meta.id) return;
    setLoading(true);
    setErr(null);
    try {
      setComics(
        submitted
          ? await listComics(plugin, { query: submitted })
          : await listComics(plugin, { region, state }),
      );
    } catch (e) {
      setErr((e as Error).message);
      setComics([]);
    } finally {
      setLoading(false);
    }
  }, [plugin, submitted, region, state]);

  useEffect(() => {
    load();
  }, [load]);

  if (!plugin?.meta.id) return null;

  return (
    <>
      <header className="topbar">
        <form className="search" onSubmit={(e) => { e.preventDefault(); setSubmitted(q.trim()); }}>
          <IconSearch size={17} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索"
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
        <>
          <div className="filters">
            {REGIONS.map((c) => (
              <button
                key={c.key}
                className={`chip${region === c.key ? ' on' : ''}`}
                onClick={() => setRegion(c.key)}
              >
                {c.label}
              </button>
            ))}
            <span style={{ width: 1, background: 'var(--border)', margin: '4px', flexShrink: 0 }} />
            {STATES.map((c) => (
              <button
                key={c.key}
                className={`chip${state === c.key ? ' on' : ''}`}
                onClick={() => setState(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div
            style={{
              padding: '6px 12px',
              fontSize: 11,
              color: 'var(--text-faint)',
              borderBottom: '1px solid var(--border)',
            }}
          >
            筛选值取自通用预设，若你的站点参数不同，请在设置里改 URL 模板
          </div>
        </>
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
        ) : !comics || comics.length === 0 ? (
          <div className="empty">
            <IconEmpty />
            <div>没有内容</div>
            <Link to="/settings" className="btn btn--sm">
              调整站点配置
            </Link>
          </div>
        ) : (
          <div className="grid">
            {comics.map((c) => (
              <Link key={c.slug} to={`/comic/${c.slug}`} className="card">
                <div className="card__cover">
                  {c.cover && (
                    <img
                      src={coverUrl(c.cover, 300, 400)}
                      alt={c.title}
                      loading="lazy"
                      decoding="async"
                    />
                  )}
                </div>
                <div className="card__name">{c.title}</div>
                {c.latestChapter && <div className="card__sub">{c.latestChapter}</div>}
              </Link>
            ))}
          </div>
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
        <Link to="/settings">
          <IconSettings />
          设置
        </Link>
      </nav>
    </>
  );
}
