import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { listComics, coverUrl, type Comic } from '@/site/engine';
import type { Plugin, PluginFilter } from '@/site/types';
import { usePlugin } from '@/store/PluginContext';
import { IconChevronRight, IconEmpty, IconSearch } from '@/components/Icons';
import SourceSwitcher from '@/components/SourceSwitcher';
import { ErrorBox, Loading, Sheet } from '@/components/UI';

/**
 * 超过这个选项数的维度收成一颗摘要按钮，点开才铺满。
 *
 * 定在 8：包子漫画那两排（5 + 3）和拷貝漫畫的地区/状态/排序（4/4/3）都直接点得到，
 * 而 69 项的题材在手机上横滚到第七个就没了、也没有任何"还能滑"的暗示，
 * 看着就像被裁掉了 —— 这种不如给人一屏挑完。
 */
const INLINE_MAX = 8;

/**
 * 没写 `filters` 的老插件的兜底预设：分类页模板里出现这两个名字，就按这一套画按钮。
 *
 * 它只服务"升级格式之前导入的插件"，不是新插件该走的路 —— 别的站点的地区
 * 压根不是这几个值（拷貝漫畫用 region=0/1/2），状态也叫 status 不叫 state。
 */
const LEGACY_FILTERS: Record<string, PluginFilter> = {
  region: {
    key: 'region',
    options: [
      { value: 'all', label: '全部' },
      { value: 'cn', label: '国漫' },
      { value: 'jp', label: '日本' },
      { value: 'kr', label: '韩国' },
      { value: 'en', label: '欧美' },
    ],
  },
  state: {
    key: 'state',
    options: [
      { value: 'all', label: '全部' },
      { value: 'serial', label: '连载中' },
      { value: 'pub', label: '已完结' },
    ],
  },
};

/**
 * 这一站发现页画哪几排按钮。
 *
 * 顺序照插件声明的来；模板里用了内置名字而插件没声明的，补在后面，
 * 这样老插件不会因为格式升级突然没了筛选。模板里没出现的维度一律不画 ——
 * 画了就是点了不会变的死按钮。
 */
function filterGroups(plugin: Plugin): PluginFilter[] {
  const used = [...(plugin.urls.classify ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const out = (plugin.filters ?? []).filter((f) => used.includes(f.key));
  for (const name of used) {
    if (!out.some((f) => f.key === name) && LEGACY_FILTERS[name]) out.push(LEGACY_FILTERS[name]);
  }
  return out;
}

export default function ExplorePage() {
  const { plugin } = usePlugin();
  /** 详情页的地址要带内容源：同一串 slug 在别的站是另一本书 */
  const pid = plugin?.meta.id ?? '';
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  /** 用户点过的维度。没点过的走各维度自己声明的 default，所以换源不必逐个重置 */
  const [picked, setPicked] = useState<Record<string, string>>({});
  /** 正摊开挑选项的那个维度（选项太多，一排放不下） */
  const [openFilter, setOpenFilter] = useState<PluginFilter | null>(null);
  const [comics, setComics] = useState<Comic[] | null>(null);
  const [exact, setExact] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const groups = useMemo(() => (plugin ? filterGroups(plugin) : []), [plugin]);
  const activeOf = useCallback((f: PluginFilter) => picked[f.key] ?? f.default ?? '', [picked]);
  const labelOf = (f: PluginFilter, value: string) =>
    f.options.find((o) => o.value === value)?.label ?? value;
  const vars = useMemo(
    () => Object.fromEntries(groups.map((f) => [f.key, activeOf(f)])),
    [groups, activeOf],
  );

  const load = useCallback(async () => {
    if (!plugin?.meta.id) return;
    setLoading(true);
    setErr(null);
    try {
      const result = submitted
        ? await listComics(plugin, { query: submitted })
        : await listComics(plugin, vars);
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
  }, [plugin, submitted, vars]);

  useEffect(() => {
    load();
  }, [load]);

  /* 切筛选/搜索时立即清空，避免旧结果停留造成误解 */
  useEffect(() => {
    setComics(null);
    setExact(true);
  }, [submitted, vars, plugin?.meta.id]);

  /* 换源等于换了个站：搜索词和筛选值带过去只会是别的站的参数，清空重来 */
  const resetForSource = useCallback(() => {
    setQ('');
    setSubmitted('');
    setPicked({});
    setOpenFilter(null);
  }, []);

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

      <SourceSwitcher onPick={resetForSource} />

      {/*
       * 一个维度一行。选项多的收成一颗摘要按钮点开挑 ——
       * 69 项的题材塞进横滚，手机上滚到第七个就没了，还看不出能滚。
       */}
      {!submitted &&
        groups.map((g) =>
          g.options.length > INLINE_MAX ? (
            <div className="filter-row" key={g.key}>
              {/*
               * 和短维度同一套结构：维度名在排首，按钮只放当前值。
               * 把名字塞进按钮肚子里会立刻和旁边几排长得不一样 —— 同一排里
               * 字号、粗细、内边距都变了，看着像另一个控件。
               */}
              <span className="filter-row__label">{g.label ?? '筛选'}</span>
              <div className="filters">
                <button
                  type="button"
                  className={`chip filter-pill${activeOf(g) === (g.default ?? '') ? '' : ' on'}`}
                  onClick={() => setOpenFilter(g)}
                >
                  {labelOf(g, activeOf(g))}
                  <IconChevronRight size={14} />
                </button>
              </div>
            </div>
          ) : (
            <div className="filter-row" key={g.key}>
              {g.label && <span className="filter-row__label">{g.label}</span>}
              <div className="filters">
                {g.options.map((o) => (
                  <button
                    key={o.value}
                    className={`chip${activeOf(g) === o.value ? ' on' : ''}`}
                    onClick={() => setPicked((p) => ({ ...p, [g.key]: o.value }))}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          ),
        )}

      {openFilter && (
        <Sheet title={openFilter.label ?? '筛选'} onClose={() => setOpenFilter(null)}>
          <div className="filter-sheet">
            {openFilter.options.map((o) => (
              <button
                key={o.value}
                className={`chip${activeOf(openFilter) === o.value ? ' on' : ''}`}
                onClick={() => {
                  setPicked((p) => ({ ...p, [openFilter.key]: o.value }));
                  setOpenFilter(null);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </Sheet>
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
            <Link to="/settings?tab=sources" className="btn btn--sm">
              调整插件配置
            </Link>
          </div>
        ) : (
          <div className="grid">
            {comics.map((c) => (
              <Link key={c.slug} to={`/comic/${pid}/${c.slug}`} className="card">
                <div className="card__cover">
                  {c.cover && (
                    <img
                      src={coverUrl(plugin, c.cover, 300, 400)}
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

    </>
  );
}
