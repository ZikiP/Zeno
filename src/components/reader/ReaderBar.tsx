import {
  IconBack,
  IconBookmark,
  IconContract,
  IconDouble,
  IconExpand,
  IconList,
  IconNotes,
  IconRows,
  IconSettings,
  IconShelf,
} from '@/components/Icons';

export interface ReaderBarProps {
  visible: boolean;
  /** 进度描述，如 "12 / 25" 或 "离线 · 12 / 25" */
  title: string;
  /** 右起模式下在标题后显示 */
  rtl?: boolean;
  mode: 'scroll' | 'paged';
  /** 当前页是否已收藏 */
  marked: boolean;
  /** 这台设备有没有元素级 Fullscreen API。没有就不画这颗按钮，别摆一个点了没反应的 */
  canFullscreen: boolean;
  fullscreen: boolean;
  onBack: () => void;
  /** 直接回书架。返回那颗退的是"上一页"，读到哪里想收工不该靠多按几下 */
  onShelf: () => void;
  onSettings: () => void;
  onChapters: () => void;
  onBookmarks: () => void;
  onToggleMark: () => void;
  onToggleMode: () => void;
  onToggleFullscreen: () => void;
}

export default function ReaderBar(p: ReaderBarProps) {
  return (
    <div className={`reader__bar${p.visible ? '' : ' hide'}`}>
      <button className="icon-btn" onClick={p.onBack} aria-label="返回">
        <IconBack />
      </button>
      <button className="icon-btn" onClick={p.onShelf} aria-label="回书架" title="回书架">
        <IconShelf />
      </button>

      <div className="reader__title">
        {p.title}
        {p.rtl && ' ←右起'}
      </div>

      <button className="icon-btn" onClick={p.onSettings} aria-label="阅读设置">
        <IconSettings />
      </button>
      <button className="icon-btn" onClick={p.onChapters} aria-label="章节目录">
        <IconList />
      </button>
      <button
        className="icon-btn"
        onClick={p.onBookmarks}
        aria-label="书签与笔记"
        title="书签与笔记"
      >
        <IconNotes />
      </button>
      <button
        className={`icon-btn${p.marked ? ' is-on' : ''}`}
        onClick={p.onToggleMark}
        aria-label="收藏本页"
        title={p.marked ? '取消收藏本页' : '收藏本页'}
      >
        <IconBookmark filled={p.marked} />
      </button>
      <button
        className="icon-btn"
        onClick={p.onToggleMode}
        aria-label="切换模式"
        title={p.mode === 'scroll' ? '切到左右翻页' : '切到竖向滚动'}
      >
        {p.mode === 'scroll' ? <IconDouble /> : <IconRows />}
      </button>
      {p.canFullscreen && (
        <button
          className={`icon-btn${p.fullscreen ? ' is-on' : ''}`}
          onClick={p.onToggleFullscreen}
          aria-label={p.fullscreen ? '退出全屏' : '全屏阅读'}
          title={p.fullscreen ? '退出全屏' : '全屏阅读'}
        >
          {p.fullscreen ? <IconContract /> : <IconExpand />}
        </button>
      )}
    </div>
  );
}
