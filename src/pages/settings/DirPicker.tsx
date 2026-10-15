import { useEffect, useState } from 'react';
import { formatBytes } from '@/store/utils';
import { browseDirs, type DirListing } from './cacheApi';

/**
 * 服务端目录下钻选择器。
 *
 * 为什么不是浏览器的文件夹选择器：showDirectoryPicker 选的是**客户端**
 * （手机、平板）的文件系统，而缓存目录是**服务端那台机器**的路径；
 * 而且它出于沙箱设计根本不返回绝对路径字符串。
 * 所以「浏览」只能由服务端报目录、界面一层层点下去。
 */
export default function DirPicker({
  onPick,
  onCancel,
}: {
  onPick: (path: string) => void;
  onCancel: () => void;
}) {
  /** 走过的路径，'' 表示根列表（盘符 / 挂载点） */
  const [stack, setStack] = useState<string[]>(['']);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const path = stack[stack.length - 1];

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setErr(null);
    browseDirs(path)
      .then((l) => {
        if (!cancelled) setListing(l);
      })
      .catch((e) => {
        // 读不了的目录（权限、正在弹出的U盘）报错就停在这层，不用弹走
        if (!cancelled) setErr((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const atRoots = !path;

  return (
    <div className="dirpick">
      <div className="dirpick__bar">
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => setStack((s) => s.slice(0, -1))}
          disabled={stack.length < 2}
        >
          上一级
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => setStack([''])} disabled={atRoots}>
          盘符
        </button>
        <div className="topbar__spacer" />
        {!atRoots && (
          <button className="btn btn--sm" onClick={() => onPick(path)}>
            选这里
          </button>
        )}
      </div>

      <div className="dirpick__where">
        {atRoots
          ? '选一个盘或挂载点'
          : `${path}${listing?.freeBytes ? ` · 剩余 ${formatBytes(listing.freeBytes)}` : ''}`}
      </div>

      {err && <div className="notice-err">{err}</div>}

      <div className="dirpick__list chapters">
        {listing?.entries.map((e) => (
          <button key={e.path} className="chapter-row" onClick={() => setStack((s) => [...s, e.path])}>
            <span className="chapter-row__name">{e.name}</span>
            <span style={{ color: 'var(--text-faint)' }}>›</span>
          </button>
        ))}
        {!busy && !err && listing && listing.entries.length === 0 && (
          <div className="chapter-row" style={{ color: 'var(--text-faint)' }}>
            下面没有子目录 —— 可以直接选当前这个
          </div>
        )}
      </div>

      {listing?.truncated && (
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6 }}>
          这一层子目录太多，只列出前 {listing.entries.length} 个
        </div>
      )}

      <button className="btn btn--ghost btn--sm" style={{ marginTop: 10 }} onClick={onCancel}>
        收起
      </button>
    </div>
  );
}
