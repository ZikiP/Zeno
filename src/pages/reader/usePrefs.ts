import { useCallback, useEffect, useMemo, useState } from 'react';
import { onDataChange } from '@/store/dataEvents';
import { getBookPrefs, saveBookPrefs } from '@/store/bookPrefs';
import {
  isReaderMode,
  loadPrefs,
  savePrefs,
  pickBook,
  pickDevice,
  type BookPrefs,
  type ReaderMode,
  type ReaderPrefs,
} from '@/reader/prefs';
import { adoptLegacyBookMode, loadBookMode, saveBookMode } from '@/sync/bookModes';

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
 * 阅读方式比别人多一层：每本书一个独立的同步键（sync/bookModes.ts），
 * 不进 bookPrefs 那行 JSON —— 否则两台设备同时改不同项会整行互相覆盖。
 *
 * 全局那份同时是同步键 readerPrefs（见 sync/transfer.ts），设备级的改动
 * 靠它跨设备传播；单书记录则是一行一本，各自 LWW。
 */

const EMPTY_BOOK: Partial<BookPrefs> = {};

/** 这一本书该用哪一档：独立键优先，没有就吃全局默认 */
function modeFor(bookKey: string | null, fallback: ReaderMode): ReaderMode {
  return (bookKey ? loadBookMode(bookKey) : null) ?? fallback;
}

export function usePrefs(bookKey: string | null) {
  const [base, setBase] = useState<ReaderPrefs>(() => loadPrefs());
  /**
   * bookKey 和内容一起存：换书时哪怕异步结果还没回来，渲染也不会沿用上一本的
   * 适配/方向 —— 那会在新书上闪一帧旧设置。
   */
  const [book, setBook] = useState<{ key: string | null; data: Partial<BookPrefs> }>({
    key: bookKey,
    data: {},
  });
  /**
   * 模式在挂载 / 换书时同步读一次，之后只由本机的 patch 更新。
   *
   * 远端同步回来的模式只落 localStorage，不打断正在读的这一屏：
   * 下次打开这本书才生效。本地切换仍然立即改这个状态。
   */
  const [modeState, setModeState] = useState<{ key: string | null; mode: ReaderMode }>(() => ({
    key: bookKey,
    mode: modeFor(bookKey, base.mode),
  }));

  useEffect(() => {
    setBook({ key: bookKey, data: {} });
    setModeState({ key: bookKey, mode: modeFor(bookKey, loadPrefs().mode) });
    if (!bookKey) return;
    let alive = true;
    void getBookPrefs(bookKey).then((p) => {
      if (!alive) return;
      /*
       * mode 以前在 bookPrefs 里，老记录可能还带着。接过来写进独立键，
       * 然后从 book 里剔掉 —— 避免两处值打架。
       */
      const { mode: legacy, ...rest } = (p ?? {}) as Partial<BookPrefs> & { mode?: unknown };
      setBook({ key: bookKey, data: rest });
      /*
       * 第一次打开老记录时，本屏就用它搬过来的那一档；
       * 独立键已经有时 adopt 返回 null，不覆盖同步来的新选择。
       */
      const adopted = adoptLegacyBookMode(bookKey, legacy);
      if (adopted) {
        setModeState((prev) => (prev.key === bookKey ? { key: bookKey, mode: adopted } : prev));
      }
    });
    return () => {
      alive = false;
    };
  }, [bookKey]);

  const currentBook = book.key === bookKey ? book.data : EMPTY_BOOK;
  /*
   * 换书那一帧状态可能还没跟上，直接从 localStorage 算，别先画错视图。
   */
  const mode = modeState.key === bookKey ? modeState.mode : modeFor(bookKey, base.mode);
  const value = useMemo<ReaderPrefs>(
    () => ({ ...base, ...currentBook, mode }),
    [base, currentBook, mode],
  );

  const patch = useCallback(
    async (delta: Partial<ReaderPrefs>) => {
      const bookPart = pickBook(delta);
      // 设备级按 DEVICE_KEYS 挑，不在这儿手写清单 —— 见 reader/prefs.ts 那段
      const devPart = pickDevice(delta);
      const nextMode = isReaderMode(delta.mode) ? delta.mode : undefined;

      /*
       * 先更新内存里的值再落库。切阅读方式时视图会跟着 mode 一起换，
       * 等 IndexedDB 写完再更新的话，会先在旧视图上闪一下归零。
       */
      const hasBookPart = !!bookKey && Object.keys(bookPart).length > 0;
      if (hasBookPart) {
        setBook((prev) =>
          prev.key === bookKey
            ? { key: bookKey, data: { ...prev.data, ...bookPart } }
            : { key: bookKey, data: bookPart },
        );
      }
      if (nextMode) {
        if (bookKey) saveBookMode(bookKey, nextMode);
        setModeState({ key: bookKey, mode: nextMode });
      }
      /*
       * 设备级只有在这本书没记过该项时才起作用 —— 但全局那份仍要写，
       * 它同时是"新书的默认值"。所以这里不判断"是否被覆盖"，一律更新。
       */
      setBase((prev) => {
        const next: ReaderPrefs = {
          ...prev,
          ...bookPart,
          ...devPart,
          ...(nextMode ? { mode: nextMode } : {}),
        };
        savePrefs(next);
        return next;
      });
      if (hasBookPart) await saveBookPrefs(bookKey, bookPart);
    },
    [bookKey],
  );

  // 同步拉回别处的偏好后重读两层。模式刻意不在这里跟：见上面 modeState 的注释
  useEffect(() => {
    return onDataChange(() => {
      setBase(loadPrefs());
      if (!bookKey) return;
      const key = bookKey;
      void getBookPrefs(key).then((p) => {
        const { mode: legacy, ...rest } = (p ?? {}) as Partial<BookPrefs> & { mode?: unknown };
        setBook((prev) => (prev.key === key ? { key, data: rest } : prev));
        adoptLegacyBookMode(key, legacy);
      });
    });
  }, [bookKey]);

  return { value, patch };
}
