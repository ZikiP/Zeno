import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Chapter } from '@/site/engine';
import { formatBytes } from '@/store/db';

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
  // 站点给的顺序通常是「新 → 旧」，倒过来让最新章排在最前
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
          return (
            <Link
              key={ch.id}
              to={`/read/${pluginId}/${slug}/${ch.id}`}
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
