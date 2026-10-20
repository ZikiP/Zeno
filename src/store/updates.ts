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

/**
 * 追更结果。
 *
 * 一次书架加载会触发好几轮数据变更（同步推、同步拉、本地进度回填），
 * 每轮都去问一次服务端，实测同一屏发了 4 次 /api/updates。请求本身不贵，
 * 但没必要；顺手把并发的和短时间内的重复请求合成一次。
 *
 * force 留给"手动检查"那条轮询：它必须看到每一拍的新结果。
 */
const UPDATES_TTL_MS = 5_000;
let updatesCache: { at: number; info: UpdateInfo } | null = null;
let updatesInflight: Promise<UpdateInfo> | null = null;

export function getUpdates(force = false): Promise<UpdateInfo> {
  if (!force && updatesCache && Date.now() - updatesCache.at < UPDATES_TTL_MS) {
    return Promise.resolve(updatesCache.info);
  }
  if (updatesInflight) return updatesInflight;

  updatesInflight = serverCall<UpdateInfo>('/api/updates')
    .then((info) => {
      updatesCache = { at: Date.now(), info };
      return info;
    })
    .finally(() => {
      updatesInflight = null;
    });
  return updatesInflight;
}

/** 翻开了一本书 → 服务端把基线对齐到这份，徽章自己就消失 */
export const reportSeen = (key: string, anchors: number) =>
  serverCall<{ ok: boolean }>('/api/updates/seen', {
    method: 'POST',
    body: JSON.stringify({ key, anchors }),
  });

/**
 * 用户按"现在检查"。这颗按钮的意思就是"别管那道 6 小时的闸门"，所以显式带 force。
 *
 * 服务端收下就去跑一轮，不等结果（一轮几十秒）。不带 force 的那条路是定时那一轮走的，
 * 端点两个都要能表达，否则"闸门该跳过的书确实被跳过"这件事在线上和测试里都无从验证。
 */
export const checkUpdatesNow = () =>
  serverCall<{ started: boolean; force?: boolean }>(
    '/api/updates/check',
    { method: 'POST', body: JSON.stringify({ force: true }) },
    10_000,
  );
