/** 书架条目 */
export interface ShelfEntry {
  /** 组合键 `${pluginId}/${slug}` */
  key: string;
  pluginId: string;
  slug: string;
  title: string;
  cover: string;
  addedAt: number;
  /**
   * 这条书架记录（标题 / 封面 / 是否在册）最近一次变动的时间，同步的 LWW 时钟。
   *
   * 必须和 addedAt 分开。addedAt 同时要当书架排序依据（用户什么时候加的），
   * 又要当"我这份有多新"来跟删除墓碑比 —— 一个字段两个用途会互相咬：
   * 为了排序而保留旧 addedAt 的设备，会被一条本该已经过期的墓碑把
   * 重新加回来的漫画再删一次，而且每轮同步都删一遍。
   */
  updatedAt?: number;
  /** 最近读到的章节 */
  lastChapterId?: string;
  /** 各章的阅读进度百分比 */
  positions: Record<string, number>;
  /**
   * 各章进度各自的写入时间。
   *
   * 同步要靠它：之前推进度时现算 Date.now()，于是每轮同步都把全部进度
   * 刷成"刚刚更新过"，服务端 change_log 无意义膨胀，LWW 也退化成
   * "最近同步的那台赢"。时间戳必须跟着真实写入走。
   */
  positionsAt?: Record<string, number>;
  /** lastChapterId 的写入时间 */
  lastChapterAt?: number;
}
