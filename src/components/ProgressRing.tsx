/**
 * 阅读进度环
 *
 * 用 SVG 而不是 conic-gradient：conic 要画环形得再叠一层遮罩，
 * 而这里就是要一根能改粗细、能跟着主题色走的弧。
 *
 * 圈上不放数字。26px 的圆里塞一行数字必然糊，而进度这个数在详情页有文字写清楚；
 * 书架卡片上只需要"读到哪了"的相对感觉，具体数值走 aria 和悬浮提示。
 */
export default function ProgressRing({
  percent,
  size = 26,
  label,
  decorative = false,
}: {
  percent: number;
  size?: number;
  /** 无障碍与悬浮提示用的完整描述 */
  label: string;
  /**
   * 旁边已经有文字说清这是几成时传 true。
   * 环自带一个 <title> 做无障碍名，跟旁边的文字叠在一块儿会被读成两遍
   * —— 章末那行"上拉接下一章"旁边挂这颗环时就是这么露出来的。
   */
  decorative?: boolean;
}) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg
      className="ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    >
      {!decorative && <title>{label}</title>}
      {/*
        底盘。没有它的话，深色封面上那圈 track 会直接融进画面里 ——
        实测进度环压在封面右上角时几乎看不见。
      */}
      <circle className="ring__bg" cx={size / 2} cy={size / 2} r={size / 2} />
      <circle
        className="ring__track"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
        fill="none"
      />
      <circle
        className="ring__arc"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - p / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
