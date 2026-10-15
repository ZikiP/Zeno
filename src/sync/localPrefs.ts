/**
 * 写一个「会被同步的本地键」
 *
 * 必须连 `${key}__at` 一起写 —— 那是同步 LWW 的判据（见 sync/transfer.ts 读它）。
 * 只写值不写时间戳的话，本地这条改动在拉取时永远输给远端（`__at` 取不到按 0 算），
 * 表现就是「我明明切了模式，同步完又弹回原来的」。
 */
export function setLocalPref(key: string, value: string): void {
  localStorage.setItem(key, value);
  localStorage.setItem(`${key}__at`, String(Date.now()));
}
