/** 书架条目 */
export interface ShelfEntry {
  /** 组合键 `${pluginId}/${slug}` */
  key: string;
  pluginId: string;
  slug: string;
  title: string;
  cover: string;
  addedAt: number;
  /** 最近读到的章节 */
  lastChapterId?: string;
  /** 各章的阅读进度百分比 */
  positions: Record<string, number>;
}
