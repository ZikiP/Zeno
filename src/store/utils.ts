/** 通用小工具 —— 不依赖数据库，避免和 store/db 形成循环引用 */

export function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 秒 → 「1 小时 23 分」这类可读文本 */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分`;
  return `${seconds} 秒`;
}

/** 相对时间：「3 天前」 */
export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const days = Math.floor(diff / 86400_000);
  if (days >= 1) return days === 1 ? '昨天' : `${days} 天前`;
  const hours = Math.floor(diff / 3600_000);
  if (hours >= 1) return `${hours} 小时前`;
  const mins = Math.floor(diff / 60_000);
  if (mins >= 1) return `${mins} 分钟前`;
  return '刚刚';
}
