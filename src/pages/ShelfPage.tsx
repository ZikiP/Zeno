import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getShelf, bookProgress, backfillProgressFields } from '@/store/shelf';
import {
  sortShelf,
  getShelfSort,
  setShelfSort,
  setShelfOrder,
  getShelfCols,
  SHELF_SORTS,
  type ShelfSort,
} from '@/store/shelfOrder';
import { getCachedChapterLists } from '@/store/chapters';
import { getUpdates, shelfUpdate, type UpdateRow } from '@/store/updates';
import type { ShelfEntry } from '@/store/types';
import { usePlugin } from '@/store/PluginContext';
import { useReloadOnChange } from '@/store/useDataVersion';
import { emitDataChange } from '@/store/dataEvents';
import { coverUrl } from '@/site/engine';
import UseAnimations from 'react-useanimations';
import { themeToggle } from '@/components/icons/uaTheme';
import { useTheme } from '@/hooks/useTheme';
import { IconEmpty, IconExplore, IconSettings, IconSort, IconCheck } from '@/components/Icons';
import ProgressEdge from '@/components/ProgressEdge';
import { ErrorBox, Loading, Sheet } from '@/components/UI';
import { sync } from '@/sync/client';
import { useShelfDrag } from './shelf/useShelfDrag';

export default function ShelfPage() {
  const { enabled, loading } = usePlugin();
  const [items, setItems] = useState<ShelfEntry[] | null>(null);
  /** 章节表缓存，按 `${pluginId}/${slug}` 索引，全书进度要用 */
  const [lists, setLists] = useState<Record<string, { id: string; index: number }[]>>({});
  const [err, setErr] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<ShelfSort>(getShelfSort);
  const [showSort, setShowSort] = useState(false);
  const [cols, setCols] = useState(getShelfCols);
  /** 服务端追更检查的结果，按 `${pluginId}/${slug}` 索引。取不到就当没有 */
  const [updates, setUpdates] = useState<Record<string, UpdateRow>>({});

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
      const items = shelf.filter((e) => byId[e.pluginId]);
      const lists = Object.fromEntries(cached.map((c) => [c.key, c.chapters]));
      setItems(items);
      setLists(lists);
      /*
       * 追更结果取不到就当没有：书架是本地数据，不该因为服务端那一轮还没跑完
       * （或者压根没开）就跟着报错。
       */
      try {
        const info = await getUpdates();
        setUpdates(Object.fromEntries(info.items.map((r) => [r.key, r])));
      } catch {
        setUpdates({});
      }
      // 老数据没记过「第几章/共几章」，趁本地有章节表补一次，别等用户再读一章
      void backfillProgressFields(items, lists).catch(() => {});
      // 排法和格子数都可能在同步里被别人改了，每次重读都跟着刷新
      setSortMode(getShelfSort());
      setCols(getShelfCols());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [byId]);

  // 同步写完本地库后自动重读，不用手动刷新页面
  useReloadOnChange(load);

  /*
   * 列数写成 CSS 变量而不是内联 style：网格的断点在样式表里（700px 那一档），
   * 由谁来生效应该是 CSS 的事。JS 只负责把"这台设备该是几列"的两个数递过去。
   */
  useEffect(() => {
    const style = document.documentElement.style;
    style.setProperty('--shelf-cols-sm', String(cols.sm));
    style.setProperty('--shelf-cols-lg', String(cols.lg));
  }, [cols]);

  const progressOf = useCallback(
    (e: ShelfEntry) => bookProgress(lists[e.key], e) ?? 0,
    [lists],
  );

  const ordered = useMemo(
    () => (items ? sortShelf(items, sortMode, progressOf) : []),
    [items, sortMode, progressOf],
  );
  const keys = useMemo(() => ordered.map((e) => e.key), [ordered]);
  const byKey = useMemo(() => Object.fromEntries(ordered.map((e) => [e.key, e])), [ordered]);

  const commitOrder = useCallback(
    (next: string[]) => {
      /*
       * 先就地乐观更新内存里那份顺序，再落库。
       *
       * 少了这一步就会看到"松手之后又交换了一下"：松手那一刻 dragKey 清空，
       * 钩子里"跟外部顺序对齐"的效果马上跑，而它拿到的 keys 还是**拖之前**的
       * 那份（落库和重读都还没回来）—— 于是界面先弹回旧顺序，等重读回来再动回
       * 新位置。实测位移正好是两格（±292px），用户看到的就是那个多余的动作。
       */
      const at = new Map(next.map((k, i) => [k, i]));
      setItems((prev) => (prev ? prev.map((e) => (at.has(e.key) ? { ...e, order: at.get(e.key) } : e)) : prev));
      void (async () => {
        const moved = await setShelfOrder(next);
        // 一行都没变就别去打扰服务端：拖了一下又放回原处是常事
        if (!moved) return;
        emitDataChange();
        void sync.sync();
      })();
    },
    [setItems],
  );

  /* 只有「自定义顺序」下才挂拖拽：自动排法下手拽的结果会被规则盖掉，那是骗人 */
  const drag = useShelfDrag({ keys, enabled: sortMode === 'custom', onCommit: commitOrder });
  /* 拖拽中：drag.order 已经把被拖那张放在它应落的位置上，
     那张卡片本身描成虚线格子，跟着手指的是钩子造的克隆 */

  /* 顶栏那颗快捷主题切换：只在浅色和深色之间跳。
     「跟随系统」要留在设置里选 —— 快捷按钮一按就该有个确定的结果 */
  const { resolved, setTheme } = useTheme();
  const dark = resolved === 'dark';

  const pickSort = (mode: ShelfSort) => {
    setSortMode(mode);
    setShelfSort(mode);
    setShowSort(false);
    void sync.sync();
  };

  /*
   * 一格书。抽出来是因为拖拽时同一张卡要出现在两个位置逻辑里
   * （流里的占位框旁边、以及列表末尾那个脱离流的本体），不能复制两份。
   */
  const renderCard = (it: ShelfEntry) => {
    /*
     * 全书进度 =（读到第几章 + 本章读到几成）/ 总章数。
     * 以前直接拿"最近一章读到几成"当进度，等于把本章进度条
     * 缩小一圈摆在封面上：200 话读到第 12 话明明是 6%，环上显示 42%。
     * 算不出来（章节表没缓存、或那章已从表里掉了）就不画 ——
     * 环上没有数字，画错了用户看不出来，宁缺。
     */
    const pct = bookProgress(lists[it.key], it);
    const update = shelfUpdate(updates[it.key], lists[it.key]?.length);
    const source = byId[it.pluginId];
    return (
      <Link
        key={it.key}
        to={`/comic/${it.pluginId}/${it.slug}`}
        data-key={it.key}
        draggable={false}
        className={`card card--plate${it.key === drag.dragKey ? ' card--slot' : ''}`}
      >
        <div className="card__cover">
          {it.cover && source && (
            <img
              src={coverUrl(source, it.cover, 300, 400)}
              alt={it.title}
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          )}
          {/*
           * 徽标用的是搜索页那张 .card__badge，位置/材质都跟着它 ——
           * 书架上凭空多出一个自己的胶囊，第一眼的感觉就是"突兀"。
           * 数得出来就报数，数不出来（手上没这份章节表）只说"有更新"。
           */}
          {update && (
            <span className="card__badge">
              {update.kind === 'count' ? `+${update.n}` : '有更新'}
            </span>
          )}
        </div>
        <div className="card__name">{it.title}</div>
        {/* 描边绕的是整块板，不是封面那格，所以挂在卡片上而不是 .card__cover 里 */}
        {pct !== null && pct > 0 && <ProgressEdge percent={pct} label={`全书 ${pct}%`} />}
      </Link>
    );
  };

  return (
    <>
      <header className="topbar">
        <div className="topbar__title">
          我的书架{items && items.length > 0 ? ` (${items.length})` : ''}
        </div>
        <div className="topbar__spacer" />
        <button
          type="button"
          className="icon-btn"
          aria-label={dark ? '切换到浅色' : '切换到深色'}
          aria-pressed={dark}
          onClick={() => setTheme(dark ? 'light' : 'dark')}
        >
          <UseAnimations
            animation={themeToggle}
            size={22}
            interaction="click-toggle"
            active={dark}
            wrapperStyle={{ overflow: 'visible' }}
          />
        </button>
        {items && items.length > 1 && (
          <button
            type="button"
            className="icon-btn"
            aria-label="书架排序方式"
            onClick={() => setShowSort(true)}
          >
            <IconSort />
          </button>
        )}
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
          /*
           * onDragStart 一律拦掉：<a href> 和 <img> 默认都是可拖的，
           * 浏览器一旦起手就发 pointercancel 接管这一串指针事件 ——
           * 表现是"鼠标拖不动，可代码是好的"（合成 PointerEvent 能拖，真鼠标不行）。
           */
          <div
            className={`grid grid--shelf${drag.dragKey ? ' is-dragging' : ''}`}
            ref={drag.containerRef}
            onDragStart={(e) => e.preventDefault()}
          >
            {drag.order.map((k) => {
              const it = byKey[k];
              return it ? renderCard(it) : null;
            })}
          </div>
        )}
      </main>


      {showSort && (
        <Sheet title="书架排序" onClose={() => setShowSort(false)}>
          <div className="settings-rows">
            {SHELF_SORTS.map((s) => (
              <button
                key={s.key}
                type="button"
                className="settings-row"
                onClick={() => pickSort(s.key)}
              >
                <span className="settings-row__name">{s.label}</span>
                <span className="settings-row__value settings-row__value--accent">
                  {sortMode === s.key ? <IconCheck size={16} /> : s.hint}
                </span>
              </button>
            ))}
          </div>
          <p className="settings-note">
            选「自定义顺序」后，长按卡片就能拖着摆；换别的排法时拖拽不可用，
            因为排完也会被规则盖回去。
          </p>
        </Sheet>
      )}
    </>
  );
}
