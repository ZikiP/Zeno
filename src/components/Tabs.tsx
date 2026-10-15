import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabEntry {
  key: string;
  label: string;
}

/**
 * 分栏切换条
 *
 * 按 WAI-ARIA 的 tabs 模式做：
 *  - roving tabindex：整组只占一个 Tab 键位，左右箭头在栏内移动。
 *    五个按钮各占一个 Tab 位的话，键盘用户要从设置页逃出去得按五次。
 *  - aria-selected / aria-controls 与面板对上，读屏才知道下面那块是哪一栏的。
 *  - 用 button 而不是 div：可聚焦、回车空格天然生效，不用自己补 keydown。
 */
export default function Tabs({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly TabEntry[];
  value: string;
  onChange: (key: string) => void;
  label: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const current = Math.max(
    0,
    items.findIndex((i) => i.key === value),
  );

  const moveTo = (n: number) => {
    const item = items[(n + items.length) % items.length];
    onChange(item.key);
    // 换栏后焦点要跟着走过去，否则键盘焦点会掉在已经变成 tabindex=-1 的旧按钮上
    refs.current[item.key]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') moveTo(current + 1);
    else if (e.key === 'ArrowLeft') moveTo(current - 1);
    else if (e.key === 'Home') moveTo(0);
    else if (e.key === 'End') moveTo(items.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((t, i) => (
        <button
          key={t.key}
          ref={(el) => {
            refs.current[t.key] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${t.key}`}
          aria-selected={t.key === value}
          aria-controls={`panel-${t.key}`}
          tabIndex={i === current ? 0 : -1}
          className={`tabs__item${t.key === value ? ' on' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 分栏的内容容器。
 *
 * 只渲染当前那一栏（不是 display:none）：设置页里"缓存"和"同步"都要发请求，
 * 全渲染就是开局多打两趟服务端，而且隐藏表单的焦点顺序会很怪。
 */
export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`tab-${id}`}
      tabIndex={0}
      className="tab-panel"
    >
      {children}
    </div>
  );
}
