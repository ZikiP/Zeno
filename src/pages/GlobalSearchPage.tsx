import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listComics, coverUrl, type Comic } from '@/site/engine';
import { listPlugins } from '@/store/plugins';
import type { InstalledPlugin } from '@/store/db';
import { usePlugin } from '@/store/PluginContext';
import { IconSearch } from '@/components/Icons';
import { ErrorBox, Loading } from '@/components/UI';
import { useSearchHistory } from './useSearchHistory';

interface Hit {
  comic: Comic;
  plugin: InstalledPlugin;
}

export default function GlobalSearchPage() {
  const nav = useNavigate();
  const { enabled, loading: pluginLoading } = usePlugin();
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  /** 勾选要搜哪些插件。默认全选已启用的源 */
  const [scope, setScope] = useState<string[] | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { recent, record: recordHit, clear: clearRecent } = useSearchHistory();
  /** 第几次搜索。换词/换范围后，上一次慢吞吞回来的结果不许再写进界面 */
  const runId = useRef(0);

  /*
   * 搜索范围只列已启用的源，默认也全勾上它们。
   * 停用的源不该出现在这里 —— 用户把它关掉就是不看了，跨源搜索还把它捞回来
   * 等于关不掉。以前默认只搜"当前那一个"，得手动勾选才跨得开，
   * 现在既然可以同时启用多个源，默认就该一起搜。
   */
  useEffect(() => {
    const ids = new Set(enabled.map((p) => p.meta.id));
    listPlugins().then((all) => setPlugins(all.filter((p) => ids.has(p.plugin.meta.id))));
  }, [enabled]);

  /** 没手动勾选过 = 全部已启用的源。把默认值算在这里，不在 effect 里补 setState */
  const scopeIds = useMemo(() => scope ?? enabled.map((p) => p.meta.id), [scope, enabled]);

  const search = useCallback(async () => {
    const term = submitted.trim();
    if (!term || !plugins) return;

    const targets = plugins.filter((p) => scopeIds.includes(p.plugin.meta.id));
    const mine = ++runId.current;
    setErr(null);
    setHits([]);

    if (targets.length === 0) {
      setSearching(false);
      return;
    }

    setSearching(true);

    const found: Hit[] = [];
    const errors: string[] = [];

    /*
     * 每个源一回来就追加，不再等最慢的那个。
     * 一次跨源搜索背后是每个源各一次服务端浏览器渲染，超时是 30–45 秒；
     * 以前 Promise.allSettled 要等全部结束才 setHits，一个源抽风就等于全卡住。
     * 某个源失败也不影响其他 —— 插件经常因为站点改版或网络问题失效。
     */
    await Promise.all(
      targets.map(async (p) => {
        try {
          const list = await listComics(p.plugin, { query: term });
          if (mine !== runId.current) return;
          if (!list.exact) return; // 无结果的插件不贡献条目
          for (const c of list.comics) found.push({ comic: c, plugin: p });
          setHits([...found]);
        } catch (e) {
          if (mine !== runId.current) return;
          errors.push((e as Error)?.message ?? String(e));
          setErr(
            errors.length >= targets.length
              ? errors[0]
              : `${errors.length} 个源搜索失败，其余正常`,
          );
        }
      }),
    );

    if (mine !== runId.current) return;
    setSearching(false);
    if (found.length) recordHit(term);
  }, [submitted, plugins, scopeIds, recordHit]);

  useEffect(() => {
    void search();
  }, [search]);

  const toggleScope = (id: string) => {
    // 从"当前生效的范围"增删，而不是从 null 起步：
    // 默认是全选，第一次点某个源该是**取消**它，不是把它加进去
    setScope(scopeIds.includes(id) ? scopeIds.filter((x) => x !== id) : [...scopeIds, id]);
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
              className={`chip${scopeIds.includes(p.plugin.meta.id) ? ' on' : ''}`}
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
        ) : searching && hits.length === 0 ? (
          <Loading text={`搜索 ${scopeIds.length} 个源`} />
        ) : err && hits.length === 0 ? (
          <ErrorBox message={err} onRetry={search} />
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
              {searching && <span> · 其余源还在搜…</span>}
            </div>
            <div className="grid">
              {hits.map((h, i) => {
                const pid = h.plugin.plugin.meta.id;
                return (
                  /*
                   * 结果可能来自发现页没在看的源。详情页与阅读器都按地址里的
                   * pluginId 解析，所以直接跳就行 —— 以前这里要先切一次激活源再跳
                   * （副作用是用户回不来原来那个源），现在不需要了。
                   */
                  <button
                    key={`${pid}-${h.comic.slug}-${i}`}
                    className="card"
                    onClick={() => nav(`/comic/${pid}/${h.comic.slug}`)}
                  >
                    <div className="card__cover">
                      {h.comic.cover && (
                        <img
                          src={coverUrl(h.plugin.plugin, h.comic.cover, 300, 400)}
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

    </>
  );
}
