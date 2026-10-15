import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Chapter } from '@/site/engine';
import { formatBytes } from '@/store/utils';

/**
 * 章节列表
 *
 * 长篇漫画有几百上千章，全量渲染会让手机浏览器卡住（DOM 节点过多）。
 * 这里做分批加载：先渲染最近的一批，看完再点「加载更多」。
 *
 * 默认从**最新章**开始 —— 用户来这个页面九成是为了追最新的一章。
 */
const BATCH = 100;

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
  // parseChapters 按序号升序排好，这里倒过来让最新章排在最前
  const ordered = useMemo(() => [...chapters].reverse(), [chapters]);
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
          {rest > 0 && ` · 显示最新 ${visible.length} 章`}
        </span>
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
