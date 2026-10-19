import { useEffect } from 'react';
import { getChapter } from '@/site/engine';
import type { Plugin } from '@/site/types';
import { getCachedChapter, saveChapterTable } from '@/store/chapters';
import { isImageReady, markImageReady } from '@/components/RetryableImage';
import { enhanceSource } from '@/reader/enhance';
import { loadEnhanceScreen } from '@/reader/prefs';

/** 预热下一话时顺手铺几张图 —— 只要头几张，翻过去有的看就行，不多占带宽 */
const WARM_IMAGES = 2;
/** 当前章到手后隔多久再去取下一话：那段时间是留给本屏图片的 */
const SETTLE_MS = 800;

/**
 * 下一章那一屏在屏幕上会占多宽（设备像素）。
 *
 * 预热时那一页还没挂载，量不到 offsetWidth，而增强版是按显示宽度做的 ——
 * 算错宽度等于算了一张用不上的图，缓存键也对不上。
 * 分页双屏占一半，单屏和滚动的"适应宽度"都是整个视口宽。
 */
function warmTargetWidth(perPage: number) {
  const dpr = window.devicePixelRatio || 1;
  return Math.round((window.innerWidth / (perPage > 1 ? 2 : 1)) * dpr);
}

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

    const ctrl = new AbortController();
    let dropped = false;

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const pluginId = plugin.meta.id;
          const cached = await getCachedChapter(pluginId, slug, nextId);
          if (dropped) return;

          const images = cached
            ? cached.images
            : (await getChapter(plugin, slug, nextId, { signal: ctrl.signal })).images;
          if (dropped || !images?.length) return;

          // 只存地址表：把整章几十张图偷偷下完是「离线下载」的事，不是预热的
          await saveChapterTable(pluginId, slug, nextId, images);

          const targetW = loadEnhanceScreen() ? warmTargetWidth(perPage) : 0;

          for (const src of images.slice(0, WARM_IMAGES)) {
            if (dropped) continue;
            /*
             * 增强版排在原图前面：算它要先 fetch 到字节，先发起就先把那趟网络
             * 摊进这段空闲里；而这一屏的原图地址此刻多半已经躺在浏览器缓存里了
             * （上一章就预热过同一条地址的形态）。
             */
            if (targetW) void enhanceSource(src, targetW, WARM_PRIO).catch(() => {});
            if (isImageReady(src)) continue;
            const img = new Image();
            img.onload = () => markImageReady(src);
            img.onerror = () => ctrl.abort(); // 头一张就取不到，别再往下试
            img.src = src;
          }
        } catch {
          /* 预热失败不该有任何动静：用户那边只是翻下一章时照旧等一次渲染 */
        }
      })();
    }, SETTLE_MS);

    return () => {
      dropped = true;
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [plugin, slug, nextId, ready, perPage]);
}
