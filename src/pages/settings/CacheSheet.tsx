import { useCallback, useEffect, useState } from 'react';
import { Field, FieldGroup } from '@/components/FormKit';
import { Sheet } from '@/components/UI';
import { formatBytes } from '@/store/utils';
import DirPicker from './DirPicker';
import { eraseCache, getCacheStatus, saveCacheConfig, type CacheStatus } from './cacheApi';

const MB = 1024 * 1024;

/**
 * 服务端图片缓存面板
 *
 * 管的是**服务端那台机器**上的目录，不是本机浏览器的缓存 ——
 * 浏览器的 Cache Storage 位置由浏览器自己定，网页碰不到。
 * 所以这一屏在手机上也能打开，但填路径的人应该是坐在服务端那台机器前。
 */
export default function CacheSheet({ onClose }: { onClose: () => void }) {
  const [st, setSt] = useState<CacheStatus | null>(null);
  const [dir, setDir] = useState('');
  const [maxMb, setMaxMb] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await getCacheStatus();
      setSt(s);
      setDir(s.dir);
      setMaxMb(String(Math.round(s.maxBytes / MB)));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const n = Number(maxMb);
      const s = await saveCacheConfig({
        dir: dir.trim(),
        ...(Number.isFinite(n) && n >= 0 ? { maxMb: Math.round(n) } : {}),
      });
      setSt(s);
      setDir(s.dir);
      setMaxMb(String(Math.round(s.maxBytes / MB)));
      setNote(s.enabled ? '已保存' : '已保存 —— 上限 0 表示缓存关掉了');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const s = await eraseCache();
      setSt(s);
      setNote('已清空');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const usedPct = st && st.maxBytes > 0 ? Math.min(100, (st.bytes / st.maxBytes) * 100) : 0;

  return (
    <Sheet title="图片缓存" onClose={onClose}>
      <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.7, margin: '0 0 14px' }}>
        服务端把抓来的图片在本机留一份，重读就不用再回源站。图片链接基本不变，
        所以不存在读到旧内容的问题；列表页和详情页不缓存，新话照常及时。
      </p>

      {!st && !err && <div style={{ fontSize: 13 }}>读取中…</div>}

      {st && (
        <div className="chapters" style={{ marginBottom: 14 }}>
          <div className="chapter-row">
            <span className="chapter-row__name">已缓存</span>
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
              {st.files} 张 · {formatBytes(st.bytes)}
            </span>
          </div>
          <div className="chapter-row">
            <span className="chapter-row__name">上限</span>
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
              {st.enabled ? formatBytes(st.maxBytes) : '已关闭'}
            </span>
          </div>
          {/* 清空会把目录整个删掉，那一行不能跟着消失 —— 界面跳一下
              会让人以为面板读失败了 */}
          <div className="chapter-row">
            <span className="chapter-row__name">所在盘剩余</span>
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
              {st.freeBytes === null ? '目录还没建出来' : formatBytes(st.freeBytes)}
            </span>
          </div>
        </div>
      )}

      {st && st.enabled && (
        <div className="progress" style={{ marginBottom: 14 }}>
          <div className="progress__bar" style={{ width: `${usedPct}%` }} />
        </div>
      )}

      <FieldGroup>
        <Field
          label="缓存目录"
          hint={`服务端机器上的绝对路径。不想手打就用下面的「浏览」一层层点。留空回到默认（${
            st?.defaultDir ?? '数据库旁边'
          }）。不能指进应用自己的目录。`}
          value={dir}
          onChange={setDir}
          placeholder={st?.defaultDir}
        />
        <Field
          label="容量上限（MB）"
          hint="超了按「最久没看过」裁。0 = 关掉缓存。"
          value={maxMb}
          onChange={setMaxMb}
          placeholder="512"
        />
      </FieldGroup>

      <button
        className="btn btn--ghost btn--sm"
        style={{ marginTop: 12 }}
        onClick={() => setBrowsing((b) => !b)}
      >
        {browsing ? '收起浏览' : '浏览服务端目录…'}
      </button>

      {browsing && (
        <DirPicker
          onPick={(p) => {
            setDir(p);
            setBrowsing(false);
            setNote('目录已填好，点保存才生效');
          }}
          onCancel={() => setBrowsing(false)}
        />
      )}

      {err && (
        <div className="notice-err" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
          {err}
        </div>
      )}
      {note && <div className="notice-ok" style={{ marginTop: 12 }}>{note}</div>}
      {st?.warning && (
        <div className="notice-err" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
          缓存已自动停用：{st.warning}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn btn--ghost" onClick={() => void clear()} disabled={busy || !st?.files}>
          清空
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => void save()} disabled={busy}>
          保存
        </button>
      </div>
    </Sheet>
  );
}
