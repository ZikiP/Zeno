import { useEffect } from 'react';
import type { ReaderPrefs } from '@/reader/prefs';

/**
 * 阅读器键盘快捷键
 *
 * 单独抽出来是因为它有独立的依赖集合（方向、偏好、书签回调…），
 * 混在页面里会让页面变成"什么都碰一下"。
 */

export interface HotkeyHandlers {
  /** 翻页。RTL 下方向相反，这里收的是语义化的「前进 / 后退」 */
  goForward: () => void;
  goBack: () => void;
  toggleBar: () => void;
  toggleDirection: () => void;
  toggleBookmark: () => void;
  openChapters: () => void;
  openBookmarks: () => void;
  adjustBrightness: (delta: number) => void;
  /** Esc 分两级：先关放大层，再退出阅读 */
  escape: () => void;
  /** 放大层开着时，其他快捷键都让给它 */
  zoomOpen: boolean;
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
      if (h.zoomOpen) return;

      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowRight': {
          // RTL：点左前进、点右后退。键盘方向跟着一起反过来
          const forward = e.key === 'ArrowLeft';
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
  { keys: '← →', desc: '翻页' },
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
