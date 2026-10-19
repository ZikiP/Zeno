/**
 * 追漫：开关、标记，以及"现在就踢一轮"
 *
 * 这一层**不再解地址、不再递交章节表** —— 那是上一版的做法，表现是"追漫进度
 * 取决于我点开过哪本书"：新章发布了，但没人打开详情页，服务端就永远不知道有这几章。
 * 现在台账由服务端自己补齐（warm-ledger.mjs）、地址自己解（warm-resolve.mjs）、
 * 什么时候腾盘自己判（warm-gc.mjs），客户端只留下两件只有它知道的事：
 *   1. 这本追不追（book_prefs.warm，参与同步，所以是"这本书的设置"而不是"这台设备的"）；
 *   2. 哪几章已经缓存好了 —— 那个答案只在服务端盘上，得问它。
 */
import { useCallback, useEffect, useState } from 'react';
import { getBookPrefs, saveBookPrefs } from '@/store/bookPrefs';
import { onDataChange } from '@/store/dataEvents';
import { proxied } from '@/site/fetch';
import type { Plugin } from '@/site/types';
import { serverCall } from '@/sync/serverCall';
import { sync } from '@/sync/client';

/** 一章的缓存情况。partial 的行不挂标记：铺了一半的章不该被说成"已缓存" */
export interface WarmMark {
  cached: boolean;
  state: string;
  got: number;
  partial: boolean;
  /** 整本级到期时间（取消追漫 / 移出书架排下的）。null = 没排 */
  purgeAt: number | null;
}

export interface WarmBook {
  /** 服务端的保留章数。界面上要把它说出来，不然"只缓存了 2 章"看着像坏了 */
  keep: number;
  marks: Record<string, WarmMark>;
}

export async function fetchWarmBook(pluginId: string, slug: string): Promise<WarmBook> {
  const r = await serverCall<{ keep?: number; chapters: (WarmMark & { id: string })[] }>(
    `/api/warm/book?pluginId=${encodeURIComponent(pluginId)}&slug=${encodeURIComponent(slug)}`,
  );
  const marks: Record<string, WarmMark> = {};
  for (const c of r.chapters ?? []) {
    const { id, ...mark } = c;
    marks[id] = mark;
  }
  return { keep: r.keep ?? 0, marks };
}

/**
 * 一章**已经在服务端铺完**的图片地址表，没有就 null。
 *
 * 进章本来要先为了这张表回站点把章节页重取一遍 —— 实测 baozimh 第一次 1.77 秒、
 * 之后每次 0.42 秒，而这段时间屏幕上什么都没有。服务端铺图时已经把这张表解出来了
 * （warm 表的 images 列），问一句就省掉这一整段。
 *
 * 回的是上游地址，这里过一道 `proxied()` 换成 /api/proxy 那种形态 —— 跟
 * engine.getChapter 交出来的字符串一模一样，盘上那些字节的键才对得上。
 *
 * 任何失败都当"没铺过"：离线、服务端没这一行、超时，都让调用方照老路走。
 * 超时给 3 秒而不是 serverCall 默认的 15 秒 —— 这条是捷径，捷径不该比正路还慢。
 */
export async function fetchWarmChapterImages(pluginId: string, slug: string, chapterId: string): Promise<string[] | null> {
  try {
    const r = await serverCall<{ images?: string[] }>(
      `/api/warm/chapter?pluginId=${encodeURIComponent(pluginId)}&slug=${encodeURIComponent(slug)}&chapterId=${encodeURIComponent(chapterId)}`,
      undefined,
      3_000,
    );
    return r.images?.length ? r.images.map((u) => proxied(u)) : null;
  } catch {
    return null;
  }
}

/**
 * 详情页用的那颗追漫开关。
 *
 * `warm` 是三值的：undefined = 这本书从没碰过这颗开关。这跟"碰过、而且是关着的"
 * 必须分开 —— 后者是用户下的决定，服务端要据此把整本缓存排上一天后清掉；
 * 前者什么都不该发生。
 */
export function useWarmFollow(args: { plugin: Plugin | null; slug: string; title?: string }) {
  const { plugin, slug, title } = args;
  const pluginId = plugin?.meta.id;
  const [warm, setWarm] = useState<boolean | undefined>(undefined);
  const [book, setBook] = useState<WarmBook>({ keep: 0, marks: {} });

  useEffect(() => {
    if (!pluginId) return;
    let dropped = false;
    void getBookPrefs(`${pluginId}/${slug}`).then(
      (p) => !dropped && setWarm(p?.warm),
      () => {},
    );
    return () => {
      dropped = true;
    };
  }, [pluginId, slug]);

  const refresh = useCallback(() => {
    if (!pluginId) return;
    void fetchWarmBook(pluginId, slug).then(setBook, () => {});
  }, [pluginId, slug]);

  /*
   * 标记跟着数据变更一起刷：铺完一章是服务端的事，而"读完了"是客户端刚推上去的，
   * 两边谁先谁后没有保证。订阅同一个信号，比在页面上猜时机稳。
   */
  useEffect(() => {
    refresh();
    return onDataChange(refresh);
  }, [refresh]);

  const setWarmFollow = useCallback(
    (next: boolean) => {
      if (!pluginId) return;
      /*
       * 取消要确认，而且要把话说明白：一天后清、期间追回来就不清。
       * 不说这一句，用户会以为点下去立刻掉盘，于是明明想停手又不敢点。
       */
      if (!next) {
        const name = title ? `《${title}》` : '这本';
        if (!confirm(`取消追漫${name}？已缓存的章节会在一天后清除，一天内重新追漫就原样保留。`)) return;
      }
      setWarm(next);
      /*
       * 三步必须按顺序等：写库 → 推上去 → 踢一轮。
       *
       * 服务端算"该铺哪几章"要同时认在架记录和这本书的开关，而这两样都长在客户端的
       * IndexedDB 里 —— 抢在同步之前踢一轮是空跑（实测台账一圈下来还是空的）。
       * 而同步读的就是这张表，所以它还得等在写库之后：上一版把 saveBookPrefs 丢成
       * 不 await 的 fire-and-forget，push 于是带着旧值出去，开关等于没同步。
       *
       * 开：踢一轮，用户当场就该看到第一批标记亮起来，而不是等 15 分钟。
       * 关：扫一次，让"一天后清"的钟从这一刻开始走，而不是从下一轮扫开始。
       */
      void (async () => {
        try {
          await saveBookPrefs(`${pluginId}/${slug}`, { warm: next });
        } catch {
          /* 写不进去也照样往下走：本地那份是主数据，同步那一轮会自己补 */
        }
        try {
          await sync.sync();
        } catch {
          /* 同上 */
        }
        try {
          await serverCall(next ? '/api/warm/run' : '/api/warm/sweep', { method: 'POST' });
        } catch {
          /* 同上 */
        }
        refresh();
      })();
    },
    [pluginId, slug, title, refresh],
  );

  return { warm, setWarmFollow, marks: book.marks, keep: book.keep, refresh };
}
