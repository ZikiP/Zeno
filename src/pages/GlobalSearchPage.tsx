import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listComics, coverUrl, type Comic } from '@/site/engine';
import { listPlugins, setActivePlugin } from '@/store/plugins';
import type { InstalledPlugin } from '@/store/db';
import { usePlugin, notifyPluginChanged } from '@/store/PluginContext';
import { IconSearch } from '@/components/Icons';
import BottomNav from '@/components/BottomNav';
import { ErrorBox, Loading } from '@/components/UI';
import { useSearchHistory } from './useSearchHistory';

interface Hit {
  comic: Comic;
  plugin: InstalledPlugin;
}

export default function GlobalSearchPage() {
  const nav = useNavigate();
  const { plugin: activePlugin, loading: pluginLoading } = usePlugin();
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  /** 勾选要搜哪些插件。不勾就用当前插件 */
  const [scope, setScope] = useState<string[] | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { recent, record: recordHit, clear: clearRecent } = useSearchHistory();

  useEffect(() => {
    listPlugins().then((all) => {
      setPlugins(all);
      // 默认只搜当前插件，避免首次搜索就打一堆请求
      setScope((s) => s ?? (activePlugin ? [activePlugin.meta.id] : []));
    });
  }, [activePlugin]);

  const search = useCallback(async () => {
    const term = submitted.trim();
    if (!term || !plugins) return;

    const targets = plugins.filter((p) => scope?.includes(p.plugin.meta.id));
    if (targets.length === 0) {
      setHits([]);
      return;
    }

    setSearching(true);
    setErr(null);

    const found: Hit[] = [];
    const errors: string[] = [];

    // 并发搜所有勾选的插件。某个失败不影响其他 ——
    // 插件经常因为站点改版或网络问题失效，不该让整次搜索失败。
    const results = await Promise.allSettled(
      targets.map(async (p) => ({
        plugin: p,
        list: await listComics(p.plugin, { query: term }),
      })),
    );

    for (const r of results) {
      if (r.status === 'rejected') {
        errors.push(r.reason?.message ?? String(r.reason));
        continue;
      }
      if (!r.value.list.exact) continue; // 无结果的插件不贡献条目
      for (const c of r.value.list.comics) {
        found.push({ comic: c, plugin: r.value.plugin });
      }
    }

    setHits(found);
    if (errors.length && !found.length) setErr(errors[0]);
    else if (errors.length) setErr(`${errors.length} 个源搜索失败，其余正常`);

    setSearching(false);

    if (found.length) recordHit(term);
  }, [submitted, plugins, scope, recordHit]);

  useEffect(() => {
    void search();
  }, [search]);

  const toggleScope = (id: string) => {
    setScope((s) => {
      const cur = s ?? [];
      return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    });
  };

  return (
    <>
      <header className="topbar">
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(q.trim());
          }}
        >
          <IconSearch size={17} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="跨源搜索漫画名"
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

      {/* 搜索源选择 */}
      {plugins && plugins.length > 1 && (
        <div className="filters">
          <span style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: '30px' }}>
            搜索范围
          </span>
          {plugins.map((p) => (
            <button
              key={p.plugin.meta.id}
              className={`chip${scope?.includes(p.plugin.meta.id) ? ' on' : ''}`}
              onClick={() => toggleScope(p.plugin.meta.id)}
            >
              {p.plugin.meta.icon ?? '📄'} {p.plugin.meta.name}
            </button>
          ))}
        </div>
      )}

      {/* 搜索历史 */}
      {!submitted && recent.length > 0 && (
        <div className="gs-recent">
          <div className="gs-recent__head">
            <span>最近搜过</span>
            <button onClick={clearRecent}>清空</button>
          </div>
          <div className="gs-recent__items">
            {recent.map((r) => (
              <button
                key={r}
                className="gs-recent__item"
                onClick={() => {
                  setQ(r);
                  setSubmitted(r);
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      )}

      <main className="main">
        {!submitted ? (
          pluginLoading ? (
            <Loading />
          ) : (
            <div className="empty">
              <IconSearch size={40} />
              <div>跨所有插件搜漫画</div>
              <div style={{ fontSize: 12 }}>
                勾选上方要搜的源，然后输入书名
              </div>
            </div>
          )
        ) : err && hits.length === 0 ? (
          <ErrorBox message={err} onRetry={search} />
        ) : searching ? (
          <Loading text={`搜索 ${scope?.length ?? 0} 个源`} />
        ) : hits.length === 0 ? (
          <div className="empty">
            <div>没有找到「{submitted}」</div>
            <div style={{ fontSize: 12 }}>换个关键词，或检查搜索范围</div>
          </div>
        ) : (
          <>
            {err && (
              <div className="notice-err" style={{ margin: '8px 12px' }}>
                {err}
              </div>
            )}
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-faint)' }}>
              {submitted} · 跨 {new Set(hits.map((h) => h.plugin.plugin.meta.id)).size} 个源
              找到 {hits.length} 条
            </div>
            <div className="grid">
              {hits.map((h, i) => {
                const pid = h.plugin.plugin.meta.id;
                return (
                  /*
                   * 关键：结果可能来自非当前插件。
                   * 直接跳 /comic/:slug 会被当前插件解析 —— 同名 slug 在不同站
                   * 指向完全不同的漫画。所以先切插件再跳。
                   */
                  <button
                    key={`${pid}-${h.comic.slug}-${i}`}
                    className="card"
                    onClick={async () => {
                      if (pid !== activePlugin?.meta.id) {
                        await setActivePlugin(pid);
                        notifyPluginChanged();
                      }
                      nav(`/comic/${h.comic.slug}`);
                    }}
                  >
                    <div className="card__cover">
                      {h.comic.cover && (
                        <img
                          src={coverUrl(h.comic.cover, 300, 400)}
                          alt={h.comic.title}
                          loading="lazy"
                          decoding="async"
                        />
                      )}
                      <span className="card__badge">
                        {h.plugin.plugin.meta.icon ?? ''} {h.plugin.plugin.meta.name}
                      </span>
                    </div>
                    <div className="card__name">{h.comic.title}</div>
                    {h.comic.latestChapter && (
                      <div className="card__sub">{h.comic.latestChapter}</div>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </main>

      <BottomNav />
    </>
  );
}
