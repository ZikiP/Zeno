import { useEffect } from 'react';
import type { ReaderPrefs } from '@/reader/prefs';

/**
 * 阅读器键盘快捷键
 *
 * 单独抽出来是因为它有独立的依赖集合（方向、偏好、书签回调…），
 * 混在页面里会让页面变成"什么都碰一下"。
 */

export interface HotkeyHandlers {
  /** 翻页。这里收的是语义化的「前进 / 后退」，方向差异由本 hook 按 rtl 换算 */
  goForward: () => void;
  goBack: () => void;
  /** 右起阅读。必须参与判定，否则键盘和点击区会各说各话 */
  rtl: boolean;
  toggleBar: () => void;
  toggleDirection: () => void;
  toggleBookmark: () => void;
  openChapters: () => void;
  openBookmarks: () => void;
  adjustBrightness: (delta: number) => void;
  /** Esc 退出阅读 */
  escape: () => void;
}

export function useReaderHotkeys(h: HotkeyHandlers, deps: unknown[] = []) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 输入框里打字不触发快捷键
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        h.escape();
        return;
      }

      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowRight': {
          /*
           * 必须和 tap 区一致：usePaging.tap 是「RTL 点左=前进，LTR 点右=前进」。
           * 早先这里无条件把 ArrowLeft 当前进，注释还写着"跟着一起反过来"，
           * 结果左起（国漫/韩漫）下键盘方向和点击区正好相反。
           */
          const forward = h.rtl ? e.key === 'ArrowLeft' : e.key === 'ArrowRight';
          if (forward) h.goForward();
          else h.goBack();
          e.preventDefault();
          break;
        }
        case ' ':
          e.preventDefault();
          h.toggleBar();
          break;
        case '+':
        case '=':
          h.adjustBrightness(0.1);
          break;
        case '-':
          h.adjustBrightness(-0.1);
          break;
        default: {
          const k = e.key.toLowerCase();
          if (k === 'f') h.toggleBar();
          else if (k === 'd') h.toggleDirection();
          else if (k === 'b') h.toggleBookmark();
          else if (k === 'c') h.openChapters();
          else if (k === 'k') h.openBookmarks();
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** 快捷键说明，供设置面板展示 */
export const HOTKEY_HELP = [
  { keys: '← →', desc: '翻页（方向跟随「右起 / 左起」设置）' },
  { keys: '空格 / F', desc: '显示或隐藏工具栏' },
  { keys: 'B', desc: '收藏当前页' },
  { keys: 'C', desc: '章节目录' },
  { keys: 'K', desc: '书签面板' },
  { keys: 'D', desc: '切换翻页方向' },
  { keys: '+ / -', desc: '亮度增减' },
  { keys: 'Esc', desc: '返回' },
] as const;

/** 从偏好算出亮度调整后的值 */
export function nextBrightness(current: ReaderPrefs['brightness'], delta: number): number {
  const base = current ?? 1;
  return Math.min(1, Math.max(0.3, base + delta));
}
