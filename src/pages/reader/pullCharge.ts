/**
 * 上拉蓄力的一小步数学
 *
 * 单独拿出来是因为这套东西**只能在时间里成立**：按住 1.5 秒才接、松手退回去、
 * 滚轮多久没动静算停手。界面上一眼看不出攒到几分，误判成"没反应"或"怎么自己跳了"
 * 都得重跑一遍才能知道 —— 所以把它做成纯函数，让测试能直接摆时间进来看结果。
 *
 * 状态机本身（谁在拉、图落地没有、跳没跳）在 useAutoNextChapter，
 * 这儿只管"给一段时间，攒下多少、够不够"。
 */

/** 默认要攒多久。设置里那根滑条改的就是它 */
export const PULL_MS = 1500;
/** 滑条的两端。下限不至于"一碰就跳"，上限不至于"按到手酸还不知道成没成" */
export const PULL_MIN_MS = 500;
export const PULL_MAX_MS = 5000;
/** 一档一档的粒度 */
export const PULL_STEP_MS = 100;
/** 滚轮没有"松手"这回事：超过这么久没动静就算手离开了 */
export const WHEEL_HOLD_MS = 400;
/** 松手后把这些毫秒的行程用来退回去。太快像卡住，太慢退得不干脆 */
export const DECAY_MS = 260;
/** 离底这么多像素以内算"停在章末" */
export const BOTTOM_PX = 48;
/** 离底超过这个距离就不再算停在章末（回弹和抖动不会把提示闪掉） */
export const RELEASE_PX = 160;

/** 存下来的值可能被老版本、手改、或者别的设备写坏，兜在读取处 */
export function safePullMs(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return PULL_MS;
  return Math.min(PULL_MAX_MS, Math.max(PULL_MIN_MS, Math.round(n / PULL_STEP_MS) * PULL_STEP_MS));
}

export function wheelStillActive(at: number, now: number) {
  return now - at < WHEEL_HOLD_MS;
}

/**
 * 攒一下。
 *
 * `active` 是"这会儿还在拉吗"；`landed` 是"最后一张图能画了吗"；
 * `pullMs` 是用户要的那段蓄力时长。
 * 在拉但图没落地时**既不涨也不退**：人一直按着手，图来了就该接着往上走，
 * 退回去等于让他白按一次。
 */
export function advancePull(
  accMs: number,
  dt: number,
  opts: { active: boolean; landed: boolean; pullMs?: number },
): { accMs: number; done: boolean } {
  const need = safePullMs(opts.pullMs);
  if (opts.active && opts.landed) {
    const next = accMs + dt;
    return { accMs: Math.min(next, need), done: next >= need };
  }
  if (opts.active) return { accMs: Math.min(accMs, need), done: false };
  const next = accMs - dt * (need / DECAY_MS);
  return { accMs: Math.max(0, next), done: false };
}
