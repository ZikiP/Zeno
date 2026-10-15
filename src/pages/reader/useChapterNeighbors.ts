import { useEffect, useMemo, useState } from 'react';
import { getChapterList } from '@/store/chapters';

/**
 * 阅读器里的「上一章 / 下一章」
 *
 * 按详情页缓存下来的章节表现算，而不是沿用 URL 带进来的 p/n —— 后者只在
 * 从详情页跳进来那一次有效，在阅读器里换一次章就断了，断了之后前后章同时为空，
 * 界面会一边显示「已是第一章」一边显示「已是最新章节」。
 *
 * 缓存不在（没进过详情页、或清了库）才回落到 p/n。
 */
export function useChapterNeighbors(
  pluginId: string | undefined,
  slug: string,
  chapterId: string,
  fallback: { prev: string | null; next: string | null },
): { prevId: string | null; nextId: string | null } {
  const [ids, setIds] = useState<string[] | null>(null);

  useEffect(() => {
    if (!pluginId) return;
    let cancelled = false;
    void getChapterList(pluginId, slug).then((c) => {
      if (cancelled || !c) return;
      // 前后关系全靠这个顺序，不指望存进来时恰好是升序
      setIds([...c.chapters].sort((a, b) => a.index - b.index).map((ch) => ch.id));
    });
    return () => {
      cancelled = true;
    };
  }, [pluginId, slug]);

  const { prev, next } = fallback;
  return useMemo(() => {
    if (ids) {
      const i = ids.indexOf(chapterId);
      if (i >= 0) return { prevId: ids[i - 1] ?? null, nextId: ids[i + 1] ?? null };
    }
    return { prevId: prev, nextId: next };
  }, [ids, chapterId, prev, next]);
}
