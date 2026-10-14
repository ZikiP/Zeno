import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { coverUrl, type Comic } from '@/site/twmanga';
import { IconEmpty } from './Icons';

/** 漫画卡片 */
export function ComicCard({ comic }: { comic: Comic }) {
  return (
    <Link to={`/comic/${comic.slug}`} className="card">
      <div className="card__cover">
        {comic.cover ? (
          <img
            src={coverUrl(comic.cover, 300, 400)}
            alt={comic.title}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div style={{ width: '100%', height: '100%' }} />
        )}
      </div>
      <div className="card__name">{comic.title}</div>
      {comic.latestChapter && <div className="card__sub">{comic.latestChapter}</div>}
    </Link>
  );
}

/** 网格容器 */
export function ComicGrid({ comics, children }: { comics: Comic[]; children?: ReactNode }) {
  if (comics.length === 0) {
    return (
      <div className="empty">
        <IconEmpty />
        <div>没找到漫画</div>
        <div style={{ fontSize: 12 }}>换个关键词试试</div>
      </div>
    );
  }
  return (
    <div className="grid">
      {comics.map((c) => (
        <ComicCard key={c.slug} comic={c} />
      ))}
      {children}
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

/** 图片懒加载 —— 进了视口才加载 */
export function LazyImage({
  src,
  alt,
  className,
  onLoad,
}: {
  src: string;
  alt: string;
  className?: string;
  onLoad?: (el: HTMLImageElement) => void;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <img
      ref={ref}
      src={visible ? src : undefined}
      alt={alt}
      className={className}
      decoding="async"
      onLoad={(e) => onLoad?.(e.currentTarget)}
      style={visible ? undefined : { minHeight: 200, background: '#000' }}
    />
  );
}
