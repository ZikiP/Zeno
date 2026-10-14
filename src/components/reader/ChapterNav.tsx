/** 章末的上一章 / 下一章。读完不用退回详情页 */
export default function ChapterNav({
  prevId,
  nextId,
  onGo,
}: {
  prevId?: string | null;
  nextId?: string | null;
  onGo: (id: string) => void;
}) {
  return (
    <div className="reader__nav">
      {prevId && (
        <button className="btn btn--ghost" onClick={() => onGo(prevId)}>
          上一章
        </button>
      )}
      {nextId ? (
        <button className="btn" onClick={() => onGo(nextId)}>
          下一章
        </button>
      ) : (
        <span className="reader__nav-end">已是最新章节</span>
      )}
    </div>
  );
}
