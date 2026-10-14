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
  /** 点击回调。传 null 表示不支持跳转（滚动模式） */
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
