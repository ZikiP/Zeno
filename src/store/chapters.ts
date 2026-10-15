import { db } from './db';
import type { CachedChapter, CachedChapterList } from './db';

/**
 * 离线缓存
 *
 * 图片同时进两处：
 *   1. Cache Storage（PWA runtime caching 也用这个 cache 名）
 *   2. IndexedDB 存章节的图片列表
 * 两边都在，断网必可看。
 */

const chapKey = (pluginId: string, slug: string, cid: string) => `${pluginId}/${slug}/${cid}`;

/**
 * 下载并发。
 * 3 是实测比较稳的值：串行太慢（一章几十张图要等很久），
 * 太高会触发上游 CDN 限流导致失败。
 */
const DOWNLOAD_CONCURRENCY = 3;

/** 单张图超时。CDN 偶尔会挂住连接，不设超时整章会卡死 */
const IMAGE_TIMEOUT_MS = 30_000;

export async function getCachedChapter(
  pluginId: string,
  slug: string,
  cid: string,
): Promise<CachedChapter | undefined> {
  return (await db()).get('chapters', chapKey(pluginId, slug, cid));
}

export interface CacheProgress {
  done: number;
  total: number;
}

/**
 * 把一章的图片下到本机。
 * 单张失败不中断整章 —— 少一张总比整章下不完强。
 */
export async function cacheChapterImages(
  pluginId: string,
  slug: string,
  cid: string,
  images: string[],
  onProgress?: (p: CacheProgress) => void,
): Promise<number> {
  const d = await db();
  let bytes = 0;
  let done = 0;

  const cache = await caches.open('comic-images');

  async function downloadOne(url: string): Promise<number> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      await cache.put(url, new Response(blob, { headers: res.headers }));
      return blob.size;
    } catch {
      return 0;
    } finally {
      clearTimeout(timer);
      done++;
      onProgress?.({ done, total: images.length });
    }
  }

  // 定长工作池：始终保持 N 个任务在跑
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(DOWNLOAD_CONCURRENCY, images.length) },
    async () => {
      while (cursor < images.length) {
        const i = cursor++;
        bytes += await downloadOne(images[i]);
      }
    },
  );
  await Promise.all(workers);

  await d.put('chapters', {
    key: chapKey(pluginId, slug, cid),
    pluginId,
    slug,
    chapterId: cid,
    images,
    cachedAt: Date.now(),
    bytes,
    downloaded: true,
  });
  return bytes;
}

/**
 * 只存地址表，一张图都不下。
 *
 * 翻开一章的时候调这个：地址表是几十 KB，存了它，重进这一章就不用再等
 * 一次服务端渲染（实测 1.4–5.6s）。整章图片交给 Service Worker 边看边存，
 * 真要搬进设备的是详情页的「离线下载」。
 */
export async function saveChapterTable(
  pluginId: string,
  slug: string,
  cid: string,
  images: string[],
): Promise<void> {
  const existing = await getCachedChapter(pluginId, slug, cid);
  /*
   * 已经整章下完的那章不能拿这张表盖回去 —— 一盖就把 downloaded 打回未下载，
   * 界面上会变成"没离线"，而盘上的图其实还在。
   */
  if (existing && existing.downloaded !== false) return;
  await (await db()).put('chapters', {
    key: chapKey(pluginId, slug, cid),
    pluginId,
    slug,
    chapterId: cid,
    images,
    cachedAt: Date.now(),
    bytes: existing?.bytes ?? 0,
    downloaded: false,
  });
}

/**
 * 这一本里**图片真的在设备上**的章。
 *
 * 只存了地址表的那些不算：调用方拿它显示"已离线 N 章 · X MB"和抽屉里的
 * 已缓存标记，把没下过的章报成离线是骗人。
 */
export async function listCachedChapters(
  pluginId: string,
  slug: string,
): Promise<CachedChapter[]> {
  const all = await (await db()).getAll('chapters');
  return all
    .filter((c) => c.pluginId === pluginId && c.slug === slug && c.downloaded !== false)
    .sort((a, b) => b.cachedAt - a.cachedAt);
}

export async function deleteCachedByPluginAndSlug(
  pluginId: string,
  slug: string,
): Promise<void> {
  const d = await db();
  const keys = (await d.getAllKeys('chapters')) as string[];
  for (const k of keys) {
    if (typeof k === 'string' && k.startsWith(`${pluginId}/${slug}/`)) {
      await d.delete('chapters', k);
    }
  }
}

/* ── 章节表缓存 ───────────────────────────────────── */

/**
 * 缓存漫画的章节表。
 * 阅读器内的目录靠它 —— 否则打开阅读器还要重新抓一次详情页。
 */
export async function cacheChapterList(
  pluginId: string,
  slug: string,
  title: string,
  chapters: { id: string; index: number; title: string }[],
): Promise<void> {
  await (await db()).put('chapterCache', {
    key: `${pluginId}/${slug}`,
    pluginId,
    slug,
    title,
    chapters,
    cachedAt: Date.now(),
  });
}

/**
 * 一次把缓存过的章节表捞出来，书架算全书进度用。
 *
 * 逐本 getChapterList 的话，几十本书就是几十次事务。
 * chapterCache 一本一行、行又小，直接全表读比建索引划算。
 */
export async function getCachedChapterLists(pluginId?: string): Promise<CachedChapterList[]> {
  const all = (await (await db()).getAll('chapterCache')) as CachedChapterList[];
  return pluginId ? all.filter((c) => c.pluginId === pluginId) : all;
}

export async function getChapterList(
  pluginId: string,
  slug: string,
): Promise<CachedChapterList | undefined> {
  return (await db()).get('chapterCache', `${pluginId}/${slug}`);
}
