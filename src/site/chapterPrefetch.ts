/**
 * 提前把一章的图片地址表拿到本地。
 *
 * 冷章真正慢的不是图片，是"为了拿地址表回站点取一次章节页"：包子是 1.3 秒的
 * HTML，拷貝要服务端跑一次浏览器（实测 4.8 秒）。用户从目录里点名某一章时，
 * 这段等待全落在黑屏上。目录打开、手指悬停、滚动停稳这些时刻都比他真正点下去
 * 早，先把表取回来存进 IndexedDB，阅读器打开时 useChapterLoader 直接命中。
 *
 * 和 useChapterLoader 共用 loadChapterShared：用户点得太快、两边同时要同一章时，
 * 上游只会跑一次，不会为了预热多花一趟。
 */
import { getCachedChapter, saveChapterTable } from '@/store/chapters';
import { fetchWarmChapterImages } from '@/store/useWarmFollow';
import { isImageReady, markImageReady } from '@/components/RetryableImage';
import type { Plugin } from './types';
import { loadChapterShared } from './chapterFetch';

const inflight = new Map<string, Promise<string[] | null>>();

/**
 * 拿到这一章的地址表（盘上 → 服务端台账 → 回站点解析），失败返回 null。
 *
 * 只存地址表，不偷偷下整章字节 —— 那是离线下载的事。同一章并发调用只跑一次。
 */
export function prefetchChapterTable(
  plugin: Plugin,
  slug: string,
  chapterId: string,
): Promise<string[] | null> {
  const pluginId = plugin.meta.id;
  const key = `${pluginId}/${slug}/${chapterId}`;
  const hit = inflight.get(key);
  if (hit) return hit;

  const p = (async () => {
    const cached = await getCachedChapter(pluginId, slug, chapterId);
    if (cached?.images?.length) return cached.images;

    const warm = await fetchWarmChapterImages(pluginId, slug, chapterId);
    if (warm?.length) {
      await saveChapterTable(pluginId, slug, chapterId, warm);
      return warm;
    }

    const result = await loadChapterShared(plugin, slug, chapterId);
    /* 残缺的一份不存：缓存是按整章存的，写进去之后缺的几页就永远补不回来 */
    if (result.truncated || !result.images.length) return null;
    await saveChapterTable(pluginId, slug, chapterId, result.images);
    return result.images;
  })()
    .catch(() => null)
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });

  inflight.set(key, p);
  return p;
}

/** 强意图（按下/悬停停稳）时顺手预热前两张原图：冷章剩下的大头就是 CDN 首包 */
export function warmChapterStart(images: readonly string[], count = 2): void {
  for (const src of images.slice(0, count)) {
    if (isImageReady(src)) continue;
    const img = new Image();
    img.fetchPriority = 'low';
    img.onload = () => markImageReady(src);
    img.src = src;
  }
}
