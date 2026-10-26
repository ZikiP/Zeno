import { setLocalPref } from './localPrefs';
import { serverNow } from './clock';
import { isReaderMode, type ReaderMode } from '@/reader/prefs';

/**
 * 每本书的阅读方式，一个键一本。
 *
 * 刻意不放在 bookPrefs 那个 JSON blob 里：那张表是一行一本、整行 LWW，
 * 两台设备同时改同一本书的不同项（一台切模式、一台调适配）会互相盖掉。
 * 挪到独立的 settings 键之后，模式只和模式自己竞争。
 *
 * 键形如 `readerMode:baozimh/slug`，靠现有的通用 settings 同步搬运，
 * 服务端不用认识这个前缀。
 */
const PREFIX = 'readerMode:';

export function bookModeKey(bookKey: string): string {
  return `${PREFIX}${bookKey}`;
}

function isBookModeKey(key: string): boolean {
  return key.startsWith(PREFIX) && !key.endsWith('__at');
}

export function loadBookMode(bookKey: string): ReaderMode | null {
  const raw = localStorage.getItem(bookModeKey(bookKey));
  return isReaderMode(raw) ? raw : null;
}

export function saveBookMode(bookKey: string, mode: ReaderMode): void {
  setLocalPref(bookModeKey(bookKey), mode);
}

/**
 * bookPrefs 里残留的旧 mode 搬到独立键，返回搬过去的档位。
 *
 * 只有独立键还没记过时才搬：两台设备先后打开同一本书时，
 * 晚到的那次不能拿旧记录把已经同步过来的新选择盖掉。
 */
export function adoptLegacyBookMode(bookKey: string, legacy: unknown): ReaderMode | null {
  if (!isReaderMode(legacy) || loadBookMode(bookKey)) return null;
  saveBookMode(bookKey, legacy);
  return legacy;
}

/** 全量导出给同步用。每本书各自带 __at，互不影响 */
export function listBookModeSettings(): {
  key: string;
  value: string;
  updatedAt: number;
}[] {
  const out: { key: string; value: string; updatedAt: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !isBookModeKey(key)) continue;
    const value = localStorage.getItem(key);
    if (!isReaderMode(value)) continue;
    out.push({
      key,
      value,
      updatedAt: Number(localStorage.getItem(`${key}__at`) ?? serverNow()),
    });
  }
  return out;
}
