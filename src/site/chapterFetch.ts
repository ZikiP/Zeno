import { getChapter } from './engine';
import type { Plugin } from './types';

/**
 * 同一章只跑一次解析。
 *
 * 详情页会提前预热「继续阅读」那一章，阅读器随后也会请求同一章；
 * 如果两边各发一次，上游会白跑两趟（browser 模式还会抢两个渲染槽）。
 * 这里按 plugin/slug/chapter 复用同一个 Promise，谁先谁后都只解析一次。
 */
type ChapterResult = Awaited<ReturnType<typeof getChapter>>;

const inflight = new Map<string, Promise<ChapterResult>>();

export function loadChapterShared(
  plugin: Plugin,
  slug: string,
  chapterId: string,
): Promise<ChapterResult> {
  const key = `${plugin.meta.id}/${slug}/${chapterId}`;
  const hit = inflight.get(key);
  if (hit) return hit;

  const p = getChapter(plugin, slug, chapterId).finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}
