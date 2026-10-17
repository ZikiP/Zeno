/**
 * 书架上那个"+N"怎么算
 *
 * 单独一个文件是因为它**谁也不依赖** —— 纯函数，所以纯逻辑测试
 * （scripts/test-updates.ts）能直接把它跟服务端的计数函数放在一起比。
 * 混在 updates.ts 里就得连带把 serverCall、同步令牌那一套都拖进测试。
 */

export interface UpdateRow {
  key: string;
  pluginId: string;
  slug: string;
  /** 服务端最近一次数到的章节条数。没取到时是 null（保持上一次的基线） */
  anchors: number | null;
  checkedAt: number;
  /** 条数最后一次变化的时刻；从没变过是 null */
  changedAt: number | null;
  error: string | null;
}

/**
 * 书架上那本该怎么说。null = 别说。
 *
 * 三种状态刻意分开：知道多了几章（有数）、只知道"变过"但手上没有章节表可对
 * （只能说"有更新"）、以及没变/取不到（什么都不画）。
 * 压成一个数字的话，"0"既要表示"不知道几章"又要表示"没有更新"，
 * 界面一定会画错一种。
 */
export type ShelfUpdate = { kind: 'count'; n: number } | { kind: 'changed' };

export function shelfUpdate(
  row: UpdateRow | undefined,
  knownChapters: number | undefined,
): ShelfUpdate | null {
  if (!row?.anchors) return null;
  if (knownChapters === undefined) return row.changedAt ? { kind: 'changed' } : null;
  const delta = row.anchors - knownChapters;
  /*
   * 0 或负数当没有更新：站点撤章、或者两边数法略有出入时，
   * 报一个"-3"或者一个假的"+1"都只会让人不再相信这个徽章。
   */
  return delta > 0 ? { kind: 'count', n: delta } : null;
}
