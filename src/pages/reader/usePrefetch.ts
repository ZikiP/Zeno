import { useEffect } from 'react';
import { loadChapterShared } from '@/site/chapterFetch';
import type { Plugin } from '@/site/types';
import { getCachedChapter, saveChapterTable } from '@/store/chapters';
import { fetchWarmChapterImages } from '@/store/useWarmFollow';
import { isImageReady, markImageReady } from '@/components/RetryableImage';
import { enhanceSource } from '@/reader/enhance';
import { loadEnhanceScreen } from '@/reader/prefs';
import { warmTargetWidth } from './usePaging';

/** 预热下一话时顺手铺几张图 —— 只要头几张，翻过去有的看就行，不多占带宽 */
const WARM_IMAGES = 2;
/**
 * 地址表提前取：它只是一个小 HTML，不占图片带宽，没必要跟着图片一起等 800ms。
 * 当前屏图片开始解码后大约 250ms 就可以发。
 */
const TABLE_DELAY_MS = 250;
/** 当前章到手后隔多久再去铺下一话的图片：那段时间是留给本屏图片的 */
const SETTLE_MS = 800;

/**
 * 预热下一话的增强版时给它一个很低的优先级。
 *
 * 这些地址还不在屏幕上，排队时该永远排在"用户脚下那一页"后面 ——
 * 但也别不算：进下一章那一帧如果只能拿到原图，就只能先画原图再硬换成增强版，
 * 那正是被报上来的那一下闪。
 */
const WARM_PRIO = 1_000_000_000;

/**
 * 下一话预热
 *
 * 为什么需要它：需要渲染的站点每开一章都要服务端跑一次浏览器（实测 2–3s），
 * 用户翻到章节边界就得干等那几秒。趁当前这章在看的时候，把下一话的地址表
 * 取回来存进 IndexedDB，翻过去就是 0 等待。
 *
 * 为什么要有 SETTLE_MS 和 WARM_IMAGES 这两个限流：预热和"正在看的那几张图"
 * 共用同一条上行链路（实测 8 并发就把带宽打满，再开只会排队）。一次铺 2 张
 * 是把等待摊到用户还没翻过去的时间里；整章铺过去会把当前屏挤到排队里去，
 * 那就成了预热制造卡顿，跟目的正好相反。
 *
 * 只热下一话不热上一话：正向阅读是绝对多数，两个方向都热等于同时占两个
 * 渲染槽（服务端一共才 3 个）。
 */
export function usePrefetchNextChapter(args: {
  plugin: Plugin | null;
  slug: string;
  nextId: string | null;
  /** 当前章已经到手（在加载或出错时不该去抢资源） */
  ready: boolean;
  /** 一屏几张，用来算下一章那一屏的显示宽度（画面增强要按它做图） */
  perPage: number;
}) {
  const { plugin, slug, nextId, ready, perPage } = args;

  useEffect(() => {
    if (!plugin || !nextId || !ready) return;
    if (document.visibilityState !== 'visible') return;

    let dropped = false;
    let imageFailed = false;

    /*
     * 地址表只做一次，两个计时器共用：
     *   - 250ms：只取表，小 HTML，不抢图片带宽
     *   - 800ms：再铺头两张图
     * 两个都走到同一个 Promise，谁先触发都只发一次上游请求。
     */
    let tablePromise: Promise<string[] | null> | null = null;
    const table = () => {
      tablePromise ??= (async () => {
        const pluginId = plugin.meta.id;
        const cached = await getCachedChapter(pluginId, slug, nextId);
        if (cached?.images?.length) return cached.images;

        const warm = await fetchWarmChapterImages(pluginId, slug, nextId);
        if (warm?.length) {
          await saveChapterTable(pluginId, slug, nextId, warm);
          return warm;
        }

        const result = await loadChapterShared(plugin, slug, nextId);
        if (result.truncated || !result.images.length) return null;
        // 只存地址表：把整章几十张图偷偷下完是「离线下载」的事，不是预热的
        await saveChapterTable(pluginId, slug, nextId, result.images);
        return result.images;
      })();
      return tablePromise;
    };

    const tableTimer = setTimeout(() => {
      void table().catch(() => null);
    }, TABLE_DELAY_MS);

    const imageTimer = setTimeout(() => {
      void (async () => {
        try {
          const images = await table().catch(() => null);
          if (dropped || !images?.length) return;

          const targetW = loadEnhanceScreen() ? warmTargetWidth(perPage, window) : 0;

          for (const src of images.slice(0, WARM_IMAGES)) {
            if (dropped || imageFailed) break;
            /*
             * 增强版排在原图前面：算它要先 fetch 到字节，先发起就先把那趟网络
             * 摊进这段空闲里；而这一屏的原图地址此刻多半已经躺在浏览器缓存里了
             * （上一章就预热过同一条地址的形态）。
             */
            if (targetW) void enhanceSource(src, targetW, WARM_PRIO).catch(() => {});
            if (isImageReady(src)) continue;
            const img = new Image();
            img.fetchPriority = 'low';
            img.onload = () => markImageReady(src);
            img.onerror = () => {
              imageFailed = true; // 头一张就取不到，别再往下试
            };
            img.src = src;
          }
        } catch {
          /* 预热失败不该有任何动静：用户那边只是翻下一章时照旧等一次渲染 */
        }
      })();
    }, SETTLE_MS);

    return () => {
      dropped = true;
      clearTimeout(tableTimer);
      clearTimeout(imageTimer);
    };
  }, [plugin, slug, nextId, ready, perPage]);
}
