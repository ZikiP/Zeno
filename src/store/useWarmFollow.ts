/**
 * 追漫：把「未读的最近几章」的图片地址表交给服务端
 *
 * 分工是刻意的：**解地址**留在客户端（解析层跑在浏览器包里，服务端不养第二套解析），
 * **下字节**交给服务端（那台机器常开、盘大，而且这一步不该占用用户的手指时间）。
 * 所以这个文件做的事就是"趁详情页开着，把最近几章的地址表取出来递过去"。
 *
 * 为什么只解最近 K 章而不是整本：解一章的地址至少是一次上游往返，browser 模式的站
 * 还要占服务端三个渲染槽之一（实测 2–3s）。整本铺过去的话，点开一本书就会把
 * 渲染槽钉满，而用户多半只想翻下一话 —— 那正是"预热制造卡顿"。
 *
 * 为什么失败要留话不静默：这条链坏掉最典型的方式是上游改版解不出图，
 * 表现是"界面开着追漫、服务端一章都没铺"。静默的话没人会发现，
 * 所以状态回给界面，哪怕只是一行小字。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getChapter } from '@/site/engine';
import type { Plugin } from '@/site/types';
import { getBookPrefs, saveBookPrefs } from '@/store/bookPrefs';
import { getCachedChapter, saveChapterTable } from '@/store/chapters';
import { READ_AT } from '@/store/shelf';
import { serverCall } from '@/sync/serverCall';

/** 详情页传进来的章节（只要这两项就够定"未读的最近几章"） */
export interface WarmTarget {
  id: string;
  index: number;
}

/**
 * 一次最多替服务端解多少章。
 *
 * 服务端那个 K 才是口径，这里只是上限保护：K 被调到很大时，
 * 也不该在详情页背后解上几百章的地址。
 */
const MAX_OFFER = 20;
/** 多解两章备着：服务端按未读判定，客户端这份进度可能比它旧一两章 */
const SLACK = 2;
/** 详情页自己的图先走完，再开始解地址 */
const SETTLE_MS = 1000;
/** 章与章之间歇一下。连续几十次上游往返跟限速是一回事 */
const GAP_MS = 1200;

/** 服务端那台机器的保留章数。一个会话里问一次就够 */
let keepCache: number | null = null;

async function serverKeep(): Promise<number> {
  if (keepCache !== null) return keepCache;
  try {
    const r = await serverCall<{ keep?: number }>('/api/warm');
    keepCache = typeof r.keep === 'number' && r.keep > 0 ? Math.round(r.keep) : 5;
  } catch {
    keepCache = 5; // 问不到就按默认递：多递几章无害，服务端自己会裁
  }
  return keepCache;
}

/** 递交一版这本书该留的集合。空数组 = 这本不追了 */
export function submitWarm(pluginId: string, slug: string, chapters: { id: string; index: number; images: string[] }[]) {
  return serverCall<{ queued: number; kept: number }>('/api/warm', {
    method: 'POST',
    body: JSON.stringify({ pluginId, slug, chapters }),
  });
}

/**
 * 取这一章的图片地址表：本地缓存表里有就用，没有才去解。
 *
 * 存回 saveChapterTable 是为了下一次打开详情页不必再解一遍。
 */
async function imagesOf(plugin: Plugin, slug: string, cid: string, signal: AbortSignal): Promise<string[] | null> {
  const cached = await getCachedChapter(plugin.meta.id, slug, cid);
  if (cached?.images?.length) return cached.images;
  try {
    const page = await getChapter(plugin, slug, cid, { signal });
    // 阅读器要的只是地址表，不下字节 —— 字节那部分是服务端的事
    await saveChapterTable(plugin.meta.id, slug, cid, page.images);
    return page.images;
  } catch {
    return null;
  }
}

/** 未读的、按章节序号从前往后排，取最近 need 章 */
function nearestUnread(chapters: WarmTarget[], positions: Record<string, number> | undefined, need: number): WarmTarget[] {
  const unread = [...chapters]
    .sort((a, b) => a.index - b.index)
    .filter((c) => (positions?.[c.id] ?? 0) < READ_AT);
  return unread.slice(0, need);
}

/**
 * 详情页用的那颗开关背后做的事。
 *
 * 从关到开会立刻跑一趟；开着的时候每次打开详情页也跑一趟（新章可能就在这中间发布了）。
 *
 * `state` 是三值的：undefined = 这本书从没碰过这颗开关，什么也不做。
 * 只有 false 才去服务端递空表 —— 否则每一本没追的书打开详情页都会写一次台账，
 * 还会把"其实没记过"当成"用户明确不要"来处理。
 */
export function useWarmFollow(args: {
  plugin: Plugin | null;
  slug: string;
  chapters: WarmTarget[];
  positions?: Record<string, number>;
}) {
  const { plugin, slug, chapters, positions } = args;
  /** 这本书的开关。undefined = 从没记过 */
  const [state, setState] = useState<boolean | undefined>(undefined);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const pluginId = plugin?.meta.id;

  useEffect(() => {
    if (!pluginId) return;
    let dropped = false;
    void getBookPrefs(`${pluginId}/${slug}`).then(
      (p) => !dropped && setState(p?.warm),
      () => {},
    );
    return () => {
      dropped = true;
    };
  }, [pluginId, slug]);

  const setWarm = useCallback(
    (v: boolean) => {
      if (!pluginId) return;
      setState(v);
      void saveBookPrefs(`${pluginId}/${slug}`, { warm: v }).catch(() => {});
    },
    [pluginId, slug],
  );

  const run = useCallback(async () => {
    if (!plugin?.meta.id || !chapters.length) return;
    if (document.visibilityState !== 'visible') return;
    ctrl.current?.abort();
    const mine = new AbortController();
    ctrl.current = mine;
    const need = Math.min(MAX_OFFER, (await serverKeep()) + SLACK);
    const targets = nearestUnread(chapters, positions, need);
    if (!targets.length) {
      setNote('没有未读的章了');
      return;
    }

    setProgress({ done: 0, total: targets.length });
    // 上一轮那句"已交给服务端 N 章"不该在这一轮跑着的时候还挂在下面
    setNote(null);
    const offered: { id: string; index: number; images: string[] }[] = [];
    let failed = 0;
    for (const t of targets) {
      if (mine.signal.aborted) return;
      const images = await imagesOf(plugin, slug, t.id, mine.signal);
      if (mine.signal.aborted) return;
      if (!images?.length) {
        failed++;
      } else {
        offered.push({ id: t.id, index: t.index, images });
        // 解出一章就递一章：服务端可以马上开始铺，不用等我把 K 章全解完
        try {
          await submitWarm(plugin.meta.id, slug, offered);
        } catch {
          /* 递不上去也别停：下一 chapter 解完再递一次，服务端那边是幂等的 */
        }
      }
      setProgress({ done: offered.length + failed, total: targets.length });
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
    const tail = failed ? `，${failed} 章没解出图（多半是站点改版）` : '';
    setNote(`已交给服务端 ${offered.length} 章${tail}`);
    setProgress(null);
  }, [plugin, slug, chapters, positions]);

  /*
   * 跑的时候永远用最新那份 run。
   *
   * 依赖里只放 chapters.length（同步每几秒就会换一次数组，不该打断正在解的那一串），
   * 于是定时器抓到的是 effect 建立那一刻的 run —— 不接一根 ref 的话，
   * 它带的是几秒前那份章节表，递上去会把服务端的台账对齐到旧的集合。
   */
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  useEffect(() => {
    if (state !== true) {
      ctrl.current?.abort();
      setProgress(null);
      if (state === false) setNote(null);
      return;
    }
    if (!pluginId || !chapters.length) return;
    const timer = setTimeout(() => void runRef.current(), SETTLE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.current?.abort();
    };
    // 关掉再打开、或者换了一本书才重跑；章节列表被同步刷一下不该打断它
  }, [state, pluginId, slug, chapters.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 明确关掉：递一份空表，让服务端把这本书的台账标掉、过了宽限期腾盘 */
  useEffect(() => {
    if (state !== false || !pluginId) return;
    void submitWarm(pluginId, slug, []).catch(() => {});
  }, [state, pluginId, slug]);

  return { warm: state, setWarm, progress, note, run };
}
