import { useEffect, useState } from 'react';
import { formatBytes } from '@/store/utils';
import { browseDirs, type DirListing } from './cacheApi';

/**
 * 服务端目录选择弹窗。
 *
 * 为什么不是浏览器的文件夹选择器：showDirectoryPicker 选的是**客户端**
 * （手机、平板）的文件系统，而缓存目录是**服务端那台机器**的路径；
 * 而且它出于沙箱设计根本不返回绝对路径字符串。
 * 所以「浏览」只能由服务端报目录、界面一层层点下去。
 *
 * 它是浮在设置面板上面的一层，所以由调用方渲染在 Sheet 之外 ——
 * .sheet 的入场动画带 transform，把 fixed 的遮罩塞在里面会跟着那块面板走位。
 */
export default function DirPicker({
  startPath,
  onPick,
  onClose,
}: {
  /** 打开时先展示哪个目录。空 = 从根（盘符/挂载点）开始 */
  startPath: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  /** 走过的路径，'' 表示根列表 */
  const [stack, setStack] = useState<string[]>([startPath || '']);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [typed, setTyped] = useState(startPath || '');
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
        // 读不了的目录（权限、正在弹出的 U 盘）报错停在原地，别把人弹走
        if (!cancelled) setErr((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  /*
   * Esc 只关这一层。设置面板那个 Sheet 也在 window 上听 Esc —— 不拦下来
   * 的话按一下 Escape 会把两层一起关掉，看起来像"关过头了"。
   * 捕获阶段 stopImmediatePropagation 能赶在它的冒泡监听之前。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);

  const atRoots = !path;
  /*
   * 上一级。栈里没来路时（直接打开就在某一层）用服务端报的父目录 ——
   * 禁掉这个按钮没道理，用户正是想往上一层才点开它的。
   */
  const parentOfView = stack.length > 1 ? stack[stack.length - 2] : (listing?.parent ?? '');
  const goTyped = () => {
    const v = typed.trim();
    if (!v) return setStack(['']);
    setStack((s) => (s[s.length - 1] === v ? s : [...s, v]));
  };

  return (
    <div className="sheet-mask" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="dirpick__head">
          <h3>选服务端的缓存目录</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="dirpick__path">
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && goTyped()}
            placeholder="直接粘路径也行，比如 D:\zeno-cache"
            aria-label="目录路径"
          />
          <button className="btn btn--sm" onClick={goTyped}>
            跳转
          </button>
        </div>

        <div className="dirpick__bar">
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : [parentOfView]))}
            disabled={stack.length < 2 && !listing?.parent}
          >
            上一级
          </button>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => setStack([''])}
            disabled={atRoots}
          >
            盘符
          </button>
          <div className="topbar__spacer" />
          <span className="dirpick__where">
            {atRoots
              ? '选一个盘或挂载点'
              : `${path}${listing?.freeBytes ? ` · 剩余 ${formatBytes(listing.freeBytes)}` : ''}`}
          </span>
        </div>

        {err && <div className="notice-err">{err}</div>}

        <div className="dirpick__list chapters">
          {listing?.entries.map((e) => (
            <button
              key={e.path}
              className="chapter-row"
              onClick={() => setStack((s) => [...s, e.path])}
            >
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

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn btn--ghost" onClick={onClose}>
            取消
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => onPick(path)} disabled={atRoots}>
            选这里
          </button>
        </div>
      </div>
    </div>
  );
}
