import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Chapter } from '@/site/engine';
import { formatBytes } from '@/store/utils';
import { IconOrderAsc, IconOrderDesc } from '@/components/Icons';

/**
 * 章节列表
 *
 * 长篇漫画有几百上千章，全量渲染会让手机浏览器卡住（DOM 节点过多）。
 * 这里做分批加载：先渲染最近的一批，看完再点「加载更多」。
 *
 * 默认从**最新章**开始 —— 用户来这个页面九成是为了追最新的一章。
 */
const BATCH = 100;

/** 章节顺序的本地偏好键。不进同步键：这是"这台设备怎么翻"的习惯，不是阅读偏好 */
const ORDER_KEY = 'chapterOrder';

export default function ChapterList({
  chapters,
  pluginId,
  slug,
  cached,
}: {
  chapters: Chapter[];
  pluginId: string;
  slug: string;
  cached: Record<string, { bytes: number }>;
}) {
  /*
   * 顺序。默认倒序（最新在最前）—— 追更的人进来就是找最新那一章。
   * 但补番的人要从第一话往下点，所以给一个开关，记住他的选择。
   * 这是浏览习惯，不是跨设备偏好，所以只落本地、不进同步键。
   */
  const [asc, setAsc] = useState(() => localStorage.getItem(ORDER_KEY) === 'asc');
  const toggleOrder = () => {
    const next = !asc;
    setAsc(next);
    localStorage.setItem(ORDER_KEY, next ? 'asc' : 'desc');
    setLimit(BATCH);
  };

  // parseChapters 按序号升序排好，倒序展示时翻一下
  const ordered = useMemo(
    () => (asc ? [...chapters] : [...chapters].reverse()),
    [chapters, asc],
  );
  const [limit, setLimit] = useState(BATCH);

  // 换漫画时重置
  useEffect(() => {
    setLimit(BATCH);
  }, [slug, pluginId]);

  const visible = ordered.slice(0, limit);
  const rest = ordered.length - visible.length;

  return (
    <>
      <div className="section-head">
        <h2>章节</h2>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
          共 {chapters.length} 章
          {rest > 0 && ` · 显示${asc ? '前' : '最新'} ${visible.length} 章`}
        </span>
        <div className="topbar__spacer" />
        <button
          className="btn btn--ghost btn--sm"
          onClick={toggleOrder}
          aria-label={`切换章节顺序，当前${asc ? '正序' : '倒序'}`}
        >
          {asc ? <IconOrderAsc size={15} /> : <IconOrderDesc size={15} />}
          {asc ? '正序' : '倒序'}
        </button>
      </div>

      <div className="chapters">
        {visible.map((ch) => {
          const hit = cached[ch.id];
          /*
           * 把前后章节 id 一起带进阅读器。
           * 路由 state 传不过刷新（刷新就没了），所以同时写进 URL 查询参数 ——
           * 阅读器读不到 state 时还能从 query 兜底。
           *
           * 必须按 chapters（升序 = 阅读顺序）取相邻项，不能按上面那个倒序展示数组：
           * 从倒序数组里取 i+1，「下一章」会指回上一话。
           */
          const pos = chapters.indexOf(ch);
          const prev = pos > 0 ? chapters[pos - 1] : undefined;
          const next =
            pos >= 0 && pos < chapters.length - 1 ? chapters[pos + 1] : undefined;

          const query = new URLSearchParams();
          if (prev) query.set('p', prev.id);
          if (next) query.set('n', next.id);
          const qs = query.toString();

          return (
            <Link
              key={ch.id}
              to={`/read/${pluginId}/${slug}/${ch.id}${qs ? `?${qs}` : ''}`}
              className="chapter-row"
            >
              <span className="chapter-row__name">{ch.title}</span>
              {hit && (
                <span className="chapter-row__badge badge-cache">
                  离线 {formatBytes(hit.bytes)}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {rest > 0 && (
        <button
          className="btn btn--ghost"
          style={{ width: '100%', marginTop: 10 }}
          onClick={() => setLimit((n) => n + BATCH)}
        >
          加载更多（还有 {rest} 章）
        </button>
      )}
    </>
  );
}
