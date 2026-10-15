/**
 * 章末导航：悬浮的玻璃胶囊，跟顶部菜单一起显隐。
 *
 * 不常驻 —— 常驻的话它就一直压在漫画最后一屏上，读的时候那是最不该占画面的位置。
 * 到边界时不隐藏按钮而是改成一句话说清楚，免得用户以为按钮坏了。
 */
export default function ChapterNav({
  prevId,
  nextId,
  visible,
  onGo,
}: {
  prevId?: string | null;
  nextId?: string | null;
  /** 工具栏在不在 —— 两者一起出现、一起收起 */
  visible: boolean;
  onGo: (id: string) => void;
}) {
  return (
    <div className="reader__nav" data-hidden={visible ? 'false' : 'true'}>
      {prevId ? (
        <button onClick={() => onGo(prevId)}>上一章</button>
      ) : (
        <span className="reader__nav-end">已是第一章</span>
      )}
      <span className="reader__nav-sep" />
      {nextId ? (
        <button onClick={() => onGo(nextId)}>下一章</button>
      ) : (
        <span className="reader__nav-end">已是最新章节</span>
      )}
    </div>
  );
}
