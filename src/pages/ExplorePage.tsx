import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listComics, coverUrl, type Comic } from '@/site/engine';
import { usePlugin } from '@/store/PluginContext';
import { IconEmpty, IconSearch } from '@/components/Icons';
import BottomNav from '@/components/BottomNav';
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
  const [exact, setExact] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!plugin?.meta.id) return;
    setLoading(true);
    setErr(null);
    try {
      const result = submitted
        ? await listComics(plugin, { query: submitted })
        : await listComics(plugin, { region, state });
      /*
       * 搜索无结果时，站点常常塞一堆推荐内容。
       * 这时把结果丢掉并明确告知「没找到」，比显示 91 部无关作品好得多。
       */
      if (!result.exact) {
        setComics([]);
        setExact(false);
      } else {
        setComics(result.comics);
        setExact(true);
      }
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

  /* 切筛选/搜索时立即清空，避免旧结果停留造成误解 */
  useEffect(() => {
    setComics(null);
    setExact(true);
  }, [submitted, region, state, plugin?.meta.id]);

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
          搜索「{submitted}」
          {comics !== null && (exact ? ` · ${comics.length} 个结果` : ' · 无结果')}
        </div>
      )}

      {/*
       * 模糊匹配提示。
       *
       * 有些站点的搜索是模糊的（匹配简介、标签而非标题），且查不到时不返回空列表
       * 而是塞推荐 —— 客户端无法区分真假结果。与其假装精准，不如说清楚。
       */}
      {submitted && exact && comics !== null && comics.length > 0 && !plugin?.parse.noResultPattern && (
        <div className="search-hint">
          该站点的搜索为模糊匹配，结果可能包含部分相关内容，请留意标题是否符合
        </div>
      )}

      <main className="main">
        {err ? (
          <ErrorBox message={err} onRetry={load} />
        ) : loading && comics === null ? (
          <Loading text="抓取中" />
        ) : submitted && !exact ? (
          <div className="empty">
            <IconEmpty />
            <div>没找到「{submitted}」</div>
            <div style={{ fontSize: 12 }}>换个关键词试试</div>
          </div>
        ) : !comics || comics.length === 0 ? (
          <div className="empty">
            <IconEmpty />
            <div>这个筛选下没有内容</div>
            <div style={{ fontSize: 12 }}>换个筛选条件，或检查插件配置</div>
            <Link to="/settings" className="btn btn--sm">
              调整插件配置
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

      <BottomNav />
    </>
  );
}
