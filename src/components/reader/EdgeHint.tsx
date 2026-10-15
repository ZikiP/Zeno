import { IconChevronLeft, IconChevronRight } from '@/components/Icons';

/**
 * 翻页到底时的边界提示
 *
 * 交互是两段式：工具栏显示时点它不动（避免误触），
 * 工具栏隐藏后再点才切章。追更时这个衔接很重要。
 */
export default function EdgeHint({
  page,
  totalPages,
  hasPrevChapter,
  hasNextChapter,
  armed,
  onGoPrev,
  onGoNext,
}: {
  page: number;
  totalPages: number;
  hasPrevChapter: boolean;
  hasNextChapter: boolean;
  /** 工具栏正在显示时为 true，此时点提示不响应 */
  armed: boolean;
  onGoPrev: () => void;
  onGoNext: () => void;
}) {
  if (totalPages <= 0) return null;
  /*
   * 菜单收起时才演这个。菜单展开时章末导航那颗悬浮胶囊已经在了，
   * 两个都出现在同一个位置会叠在一起 —— 之前是"显示但禁用"，更糟。
   */
  if (armed) return null;

  if (page === 0) {
    return (
      <button className="edge-hint" onClick={onGoPrev}>
        <IconChevronRight size={18} /> {hasPrevChapter ? '上一章' : '已是第一章'}
      </button>
    );
  }

  if (page === totalPages - 1) {
    return (
      <button className="edge-hint" onClick={onGoNext}>
        {hasNextChapter ? '下一章' : '已是最后一章'} <IconChevronLeft size={18} />
      </button>
    );
  }

  return null;
}
