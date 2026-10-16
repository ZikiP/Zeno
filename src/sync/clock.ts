/**
 * LWW 的时间基准：把这台设备的钟，挪到服务端那条时间轴上
 *
 * 整套冲突解决（server/merge.mjs 和 sync/applyRemote.ts）比的都是 updatedAt 谁大，
 * 而 updatedAt 是各设备自己的挂钟。挂钟不靠谱是常态而不是意外：手机放着不管，
 * 系统会拿 NTP 校时，校回来一次就可能偏出几分钟；虚拟机、双系统、CMOS 没电，
 * 都能让一台设备**永远**比另一台慢 —— 那台设备上的每次修改都会静默输掉同步，
 * 界面上连一句提示都没有。
 *
 * 所以这里不猜哪台设备的钟更准，而是让服务端报一次它的"现在"，
 * 本地记住差值，之后所有要参与比较的时间戳都按这条统一的时间轴盖。
 * 差值存在 localStorage 里，冷启动到第一次同步之间也带着上次的校准量。
 *
 * 注意它治的是"跨设备比钟"这一件事。两台设备真的同时改了同一行，
 * LWW 依旧是一边赢一边输 —— 那是这个模型本身的取舍，不是这里能解决的。
 */

const KEY = 'syncClockOffset';

/** 服务端时间 - 本地时间。没对过时是 0，行为等同于直接用挂钟 */
let offset = read();

function read(): number {
  const n = Number(localStorage.getItem(KEY));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 记一次服务端对时。
 *
 * 只在差值真的变了才落盘：每轮同步都写一次 localStorage 没有意义，
 * 而这个键是同步自己写的，写多了不好排查。
 */
export function observeServerTime(serverMs: number): void {
  if (!Number.isFinite(serverMs) || serverMs <= 0) return;
  const next = Math.round(serverMs - Date.now());
  if (next === offset) return;
  offset = next;
  localStorage.setItem(KEY, String(next));
}

/**
 * 给一条数据盖时间戳。
 *
 * 凡是会写进 updatedAt / positionsAt / 偏好 `__at` / 墓碑 deletedAt 的取时点都用它，
 * 别用 Date.now() —— 那些值要跨设备比大小。
 * 至于 UI 上"多久之前"那种本地展示，继续用 Date.now()，不需要跟服务端对齐。
 */
export function serverNow(): number {
  return Date.now() + offset;
}
