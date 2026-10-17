/** 底部进度条：显示位置、标记已收藏页、可点击跳转 */
export default function ReaderProgress({
  percent,
  markedPositions,
  onSeek,
}: {
  /** 0-100 */
  percent: number;
  /** 已收藏页在整章里的百分比位置 */
  markedPositions: number[];
  /**
   * 跳到这一章的哪个位置，0-1。
   * 分页模式是"第几屏"，滚动模式是滚动比例（和存下来的进度同一个口径）。
   * 传 null 表示这一章没什么可跳的（只有一张图）。
   */
  onSeek: ((ratio: number) => void) | null;
}) {
  return (
    <div
      className="reader__progress"
      onClick={(e) => {
        if (!onSeek) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek((e.clientX - rect.left) / rect.width);
      }}
    >
      {markedPositions.map((p, i) => (
        <span key={i} className="reader__progress-bm" style={{ left: `${p.toFixed(2)}%` }} />
      ))}
      <div className="reader__progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}
