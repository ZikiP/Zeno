import { useEffect, type ReactNode } from 'react';
import { IconEmpty } from './Icons';

/** 网格容器（空态提示） */
export function EmptyState({ hint }: { hint?: string }) {
  return (
    <div className="empty">
      <IconEmpty />
      <div>没有内容</div>
      {hint && <div style={{ fontSize: 12 }}>{hint}</div>}
    </div>
  );
}

/** 底部弹层 */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="sheet-mask" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** 开关行 */
export function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="opt-row" onClick={() => onChange(!value)}>
      <div>
        <div className="opt-row__label">{label}</div>
        {hint && <div className="opt-row__hint">{hint}</div>}
      </div>
      <div className={`switch${value ? ' on' : ''}`} />
    </div>
  );
}

/** 加载中 */
export function Loading({ text = '加载中' }: { text?: string }) {
  return (
    <div className="loading">
      <div className="spinner" />
      <span>{text}</span>
    </div>
  );
}

/** 错误提示 */
export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box">
      <div style={{ marginBottom: onRetry ? 10 : 0 }}>{message}</div>
      {onRetry && (
        <button className="btn btn--sm" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

/** 断网提示条 */
export function OfflineBar({ online }: { online: boolean }) {
  if (online) return null;
  return <div className="offline-bar">离线中 · 仅显示已缓存内容</div>;
}
