import type { ReactNode } from 'react';

/**
 * 阅读偏好的两种行：带标题的分节 + 一行可点的设置项
 *
 * 抽出来是因为现在有**两个**地方要摆同一套偏好：阅读器里的弹层
 * （ReaderPrefsSheet，改的是"这一本"）和设置页的「阅读」栏
 * （ReadingPanel，改的是全局默认）。同一套 DOM 和类名共用一份，
 * 免得两边各长一个样子 —— 一个圆角 8、一个 12 那种"看着别扭说不出哪儿"的差别
 * 就是这么来的。
 */

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="prefs-section">
      <div className="prefs-section__title">{title}</div>
      {children}
    </div>
  );
}

export function Row({
  icon,
  label,
  hint,
  value,
  control,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  hint?: string;
  value?: string;
  control?: ReactNode;
  /** 有则整行可点 */
  onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={`pref-row${onClick ? '' : ' pref-row--static'}`}
      {...(onClick ? { onClick } : {})}
    >
      {icon}
      <div className="pref-row__text">
        <div className="pref-row__label">{label}</div>
        {hint && <div className="pref-row__hint">{hint}</div>}
      </div>
      {value && <span className="pref-row__value">{value}</span>}
      {control}
    </Tag>
  );
}

/** 三档/四档互斥选择用的分段按钮 */
export function Seg<T extends string>({
  values,
  labels,
  hints,
  current,
  onPick,
}: {
  values: readonly T[];
  labels: Record<T, string>;
  hints?: Record<T, string>;
  current: T;
  onPick: (v: T) => void;
}) {
  return (
    <>
      <div className="seg">
        {values.map((v) => (
          <button
            key={v}
            className={`seg__item${current === v ? ' on' : ''}`}
            onClick={() => onPick(v)}
          >
            {labels[v]}
          </button>
        ))}
      </div>
      {hints && <div className="prefs-hint">{hints[current]}</div>}
    </>
  );
}
