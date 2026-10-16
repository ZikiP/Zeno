import { useCallback, useEffect, useMemo, useState } from 'react';
import { onDataChange } from '@/store/dataEvents';
import { getBookPrefs, saveBookPrefs } from '@/store/bookPrefs';
import {
  loadPrefs,
  savePrefs,
  pickBook,
  type BookPrefs,
  type DevicePrefs,
  type ReaderPrefs,
} from '@/reader/prefs';

/**
 * 阅读偏好：全局默认 + 这一本书的覆盖
 *
 * 三层合成，就近优先：
 *   DEFAULT_PREFS  ←  readerPrefs（全局默认 + 设备级）  ←  这本书的记录
 *
 * 改**显示类**（图片适配、方向、单双页、底色、灰度）时写两处：这本书的记录，
 * 以及全局那份默认值 —— 于是"我刚把这本调成右起双页"以后新开的书会跟着，
 * 而已经单独调过的书不受牵连。改**设备级**（亮度、常亮）只写全局那份，
 * 它不该跟着书走：手机的亮度偏好被搬到 27 寸显示器上是灾难。
 *
 * 全局那份同时是同步键 readerPrefs（见 sync/transfer.ts），设备级的改动
 * 靠它跨设备传播；单书记录则是一行一本，各自 LWW。
 */
export function usePrefs(bookKey: string | null) {
  const [base, setBase] = useState<ReaderPrefs>(() => loadPrefs());
  const [book, setBook] = useState<Partial<BookPrefs>>({});

  useEffect(() => {
    if (!bookKey) {
      setBook({});
      return;
    }
    let alive = true;
    void getBookPrefs(bookKey).then((p) => {
      if (alive) setBook(p ?? {});
    });
    return () => {
      alive = false;
    };
  }, [bookKey]);

  const value = useMemo<ReaderPrefs>(() => ({ ...base, ...book }), [base, book]);

  const patch = useCallback(
    async (delta: Partial<ReaderPrefs>) => {
      const bookPart = pickBook(delta);
      const devPart: Partial<DevicePrefs> = {};
      if ('keepAwake' in delta) devPart.keepAwake = delta.keepAwake;
      if ('brightness' in delta) devPart.brightness = delta.brightness;
      if ('turnAnim' in delta) devPart.turnAnim = delta.turnAnim;
      if ('turnAnim' in delta) devPart.turnAnim = delta.turnAnim;

      if (bookKey && Object.keys(bookPart).length) {
        await saveBookPrefs(bookKey, bookPart);
        setBook((prev) => ({ ...prev, ...bookPart }));
      }
      /*
       * 设备级只有在这本书没记过该项时才起作用 —— 但全局那份仍要写，
       * 它同时是"新书的默认值"。所以这里不判断"是否被覆盖"，一律更新。
       */
      setBase((prev) => {
        const next = { ...prev, ...bookPart, ...devPart };
        savePrefs(next);
        return next;
      });
    },
    [bookKey],
  );

  // 同步拉回别处的偏好后重读两层
  useEffect(() => {
    return onDataChange(() => {
      setBase(loadPrefs());
      if (bookKey) void getBookPrefs(bookKey).then((p) => setBook(p ?? {}));
    });
  }, [bookKey]);

  return { value, patch };
}
