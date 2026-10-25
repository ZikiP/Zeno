import { useState } from 'react';
import type { Plugin } from '@/site/types';
import type { Bookmark } from '@/store/db';
import type { ReaderPrefs } from '@/reader/prefs';
import ChapterDrawer from '@/components/ChapterDrawer';
import BookmarkPanel from '@/components/BookmarkPanel';
import ReaderPrefsSheet from '@/components/reader/ReaderPrefsSheet';

/**
 * 阅读器的浮层编排
 *
 * 三个面板互斥显示，逻辑集中在这里，
 * 主组件就不需要为每个面板各写一段 JSX 和一堆 state。
 */
export type PanelKind = 'none' | 'prefs' | 'chapters' | 'bookmarks';

export function useReaderPanels() {
  const [panel, setPanel] = useState<PanelKind>('none');
  return {
    panel,
    open: (p: Exclude<PanelKind, 'none'>) => setPanel(p),
    close: () => setPanel('none'),
    isOpen: (p: PanelKind) => panel === p,
  };
}

export interface ReaderPanelProps {
  panels: ReturnType<typeof useReaderPanels>;
  plugin: Plugin | null;
  mode: 'scroll' | 'paged';
  prefs: ReaderPrefs;
  fromCache: boolean;
  onPrefsChange: (patch: Partial<ReaderPrefs>) => void;
  onModeChange: (m: 'scroll' | 'paged') => void;
  /** 仅章节目录需要 */
  currentChapter: { slug: string; id: string };
  /** 各章进度，目录里用来把读过的压暗 */
  positions: Record<string, number>;
  bookmarksByChapter: Map<string, number[]>;
  onPickChapter: (id: string) => void;
  /** 目录里提前取地址表：明确意图 / 悬停 / 滚动停稳后的猜测 */
  onPrefetchChapter?: (id: string) => void;
  onPrefetchHover?: (id: string) => void;
  onPrefetchNearest?: (list: HTMLElement | null) => void;
  /** 仅书签面板需要 */
  onJumpBookmark: (b: Bookmark) => void;
}

/** 渲染当前打开的面板。没打开时返回 null。 */
export default function ReaderPanel(p: ReaderPanelProps) {
  const { panels, plugin, mode, prefs, currentChapter } = p;
  if (!plugin) return null;

  switch (panels.panel) {
    case 'prefs':
      return (
        <ReaderPrefsSheet
          prefs={prefs}
          mode={mode}
          fromCache={p.fromCache}
          onChange={p.onPrefsChange}
          onMode={p.onModeChange}
          onClose={panels.close}
        />
      );

    case 'chapters':
      return (
        <ChapterDrawer
          pluginId={plugin.meta.id}
          slug={currentChapter.slug}
          currentId={currentChapter.id}
          positions={p.positions}
          bookmarks={p.bookmarksByChapter}
          onPick={p.onPickChapter}
          onClose={panels.close}
          onPrefetchChapter={p.onPrefetchChapter}
          onPrefetchHover={p.onPrefetchHover}
          onPrefetchNearest={p.onPrefetchNearest}
        />
      );

    case 'bookmarks':
      return (
        <BookmarkPanel
          pluginId={plugin.meta.id}
          onJump={p.onJumpBookmark}
          onClose={panels.close}
        />
      );

    default:
      return null;
  }
}
