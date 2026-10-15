import { useCallback, useEffect, useState } from 'react';
import { Field, FieldGroup } from '@/components/FormKit';
import { formatBytes } from '@/store/utils';
import DirPicker from './DirPicker';
import { eraseCache, getCacheStatus, saveCacheConfig, type CacheStatus } from './cacheApi';

const MB = 1024 * 1024;

/**
 * 服务端图片缓存
 *
 * 管的是**服务端那台机器**上的目录，不是本机浏览器的缓存 ——
 * 浏览器的 Cache Storage 位置由浏览器自己定，网页碰不到。
 * 所以这一栏在手机上也能打开，但填路径的人应该是坐在服务端那台机器前。
 */
export default function CachePanel() {
  const [st, setSt] = useState<CacheStatus | null>(null);
  const [dir, setDir] = useState('');
  const [maxMb, setMaxMb] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

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
      setSt(await eraseCache());
      setNote('已清空');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const usedPct = st && st.maxBytes > 0 ? Math.min(100, (st.bytes / st.maxBytes) * 100) : 0;

  return (
    <>
      <p className="settings-note">
        服务端把抓来的图片在本机留一份，重读就不用再回源站。图片链接基本不变，
        所以不存在读到旧内容的问题；列表页和详情页不缓存，新话照常及时。
        <br />
        <em>这一栏改的是服务端那台机器的目录，不是这台设备的浏览器缓存。</em>
      </p>

      {!st && !err && <div className="settings-note">读取中…</div>}

      {st && (
        <>
          <div className="settings-rows">
            <div className="settings-row">
              <span className="settings-row__name">已缓存</span>
              <span className="settings-row__value">
                {st.files} 张 · {formatBytes(st.bytes)}
              </span>
            </div>
            <div className="settings-row">
              <span className="settings-row__name">上限</span>
              <span className="settings-row__value">
                {st.enabled ? formatBytes(st.maxBytes) : '已关闭'}
              </span>
            </div>
            {/* 清空会把目录整个删掉，这一行不能跟着消失 —— 界面跳一下会让人以为读失败了 */}
            <div className="settings-row">
              <span className="settings-row__name">所在盘剩余</span>
              <span className="settings-row__value">
                {st.freeBytes === null ? '目录还没建出来' : formatBytes(st.freeBytes)}
              </span>
            </div>
          </div>

          {st.enabled && (
            <div className="settings-progress">
              <div className="settings-progress__bar" style={{ width: `${usedPct}%` }} />
            </div>
          )}

          <FieldGroup>
            {/*
             * 目录做成"能点的一行"而不是输入框：路径是服务端那台机器的，
             * 手打最容易错，而且在手机上根本不知道该打什么。
             */}
            <button className="field-btn" onClick={() => setPicking(true)}>
              <span className="field-btn__label">缓存目录</span>
              <span className="field-btn__value">{dir || st.defaultDir || '（默认：数据库旁边）'}</span>
              <span className="field-btn__hint">点击从服务端的目录里选 · 不能指进应用自己的目录</span>
              <span className="field-btn__go" aria-hidden="true">
                ›
              </span>
            </button>
            <Field
              label="容量上限（MB）"
              hint="超了按「最久没看过」裁。0 = 关掉缓存。"
              value={maxMb}
              onChange={setMaxMb}
              placeholder="512"
            />
          </FieldGroup>
        </>
      )}

      {err && (
        <div className="notice-err" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
          {err}
        </div>
      )}
      {note && (
        <div className="notice-ok" style={{ marginTop: 12 }}>
          {note}
        </div>
      )}
      {st?.warning && (
        <div className="notice-err" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
          缓存已自动停用：{st.warning}
        </div>
      )}

      <div className="settings-actions">
        <button className="btn btn--ghost" onClick={() => void clear()} disabled={busy || !st?.files}>
          清空
        </button>
        <div className="settings-actions__spacer" />
        <button className="btn" onClick={() => void save()} disabled={busy}>
          保存
        </button>
      </div>

      {/* 目录选择弹层渲染在面板外面：它要盖住整屏，放进滚动容器里会被裁 */}
      {picking && (
        <DirPicker
          startPath={dir}
          onPick={(p) => {
            setDir(p);
            setPicking(false);
            setNote('目录已选好，点保存才生效');
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
