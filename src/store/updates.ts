import { serverCall } from '@/sync/serverCall';
import type { ShelfUpdate, UpdateRow } from './updateBadge';

/**
 * 追更：读服务端那一轮检查的结果，并把"我已经看过了"报回去
 *
 * 章节条数是**服务端数**的（见 server/updates.mjs：要"不打开应用也知道有新章"，
 * 这件事只能在服务端做），而"这本我手上有多少章"只有客户端知道 ——
 * 它手里那份章节表才是解析出来的结果。所以徽章上的数字是两边的减法，
 * 减法本身在 updateBadge.ts（纯函数，和服务端的计数一起被测试钉着）。
 */

export type { ShelfUpdate, UpdateRow };
export { shelfUpdate } from './updateBadge';

export interface UpdateInfo {
  items: UpdateRow[];
  /** 这一轮多久跑一次（服务端的环境变量决定的，界面上要说这句话） */
  roundMs: number;
  perBookMs: number;
}

export const getUpdates = () => serverCall<UpdateInfo>('/api/updates');

/** 翻开了一本书 → 服务端把基线对齐到这份，徽章自己就消失 */
export const reportSeen = (key: string, anchors: number) =>
  serverCall<{ ok: boolean }>('/api/updates/seen', {
    method: 'POST',
    body: JSON.stringify({ key, anchors }),
  });

/** 用户按"现在检查"。服务端收下就去跑一轮，不等结果（一轮几十秒） */
export const checkUpdatesNow = () =>
  serverCall<{ started: boolean }>('/api/updates/check', { method: 'POST' }, 10_000);
