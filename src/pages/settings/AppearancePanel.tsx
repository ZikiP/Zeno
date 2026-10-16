import { useCallback, useEffect, useState } from 'react';
import { useTheme, THEMES } from '@/hooks/useTheme';
import { IconMoon, IconSun, IconSystem } from '@/components/Icons';
import { getShelfCols, setShelfCols, SHELF_COLS } from '@/store/shelfOrder';
import { sync } from '@/sync/client';
import { getFonts, rescanFonts, saveFontDir, type FontsStatus } from '@/fonts/api';
import { loadFamily, pruneFontCache, readUiFont, setUiFont } from '@/fonts/apply';
import DirPicker from './DirPicker';

const icons = {
  light: <IconSun size={18} />,
  dark: <IconMoon size={18} />,
  system: <IconSystem size={18} />,
};

/** 加减一档。到边界就按不动而不是消失 —— 消失会让"已经到底了"看不出来 */
function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="settings-row settings-row--still">
      <span className="settings-row__name">{label}</span>
      <div className="stepper" role="group" aria-label={label}>
        <button
          type="button"
          className="stepper__btn"
          aria-label={`${label} 减一`}
          disabled={value <= min}
          onClick={() => onChange(value - 1)}
        >
          −
        </button>
        <span className="stepper__value" aria-live="polite">
          {value}
        </span>
        <button
          type="button"
          className="stepper__btn"
          aria-label={`${label} 加一`}
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

/**
 * 外观
 *
 * 只管这台设备怎么看。亮度和翻页方式那些是**这本书/这个阅读器**的偏好，
 * 在阅读器里的「阅读设置」，两边不该混在一栏：前者换设备也想跟着走，
 * 后者跟着同步走会把手电筒亮度带到电脑上。
 *
 * 书架格子数是例外：它跟着同步走，但**存的是两个数**——
 * 手机和显示器各取所需，于是"我把它设成 3 列"这件事不用每台设备重说一遍。
 * 界面字体是另一个例外：字体文件站在服务端的目录里，谁都能拉，
 * 所以选择直接跟着账号走。
 */
export default function AppearancePanel() {
  const { mode, setTheme } = useTheme();
  const [cols, setCols] = useState(getShelfCols);

  const change = (next: { sm: number; lg: number }) => {
    setCols(next);
    setShelfCols(next.sm, next.lg);
    void sync.sync();
  };

  return (
    <>
      <p className="settings-note">
        浅色、深色，或跟着设备的自动切换走。这台设备的选择，不参与同步。
      </p>

      <div className="theme-picker">
        {THEMES.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`theme-option${mode === t.key ? ' on' : ''}`}
            aria-pressed={mode === t.key}
            onClick={() => setTheme(t.key)}
          >
            <span className="theme-option__icon">{icons[t.key]}</span>
            <span className="theme-option__label">{t.label}</span>
            <span className="theme-option__hint">{t.hint}</span>
          </button>
        ))}
      </div>

      <h3 className="settings-h">书架格子数</h3>
      <p className="settings-note">
        按屏幕宽度分别定：窄于 700px 用小屏那一档，宽了用大屏那一档。
        两个数会同步给你的其他设备，换设备时按它自己的宽度取用。
      </p>
      <div className="settings-rows">
        <Stepper
          label="小屏（手机）"
          value={cols.sm}
          min={SHELF_COLS.sm.min}
          max={SHELF_COLS.sm.max}
          onChange={(sm) => change({ ...cols, sm })}
        />
        <Stepper
          label="大屏（平板 / 电脑）"
          value={cols.lg}
          min={SHELF_COLS.lg.min}
          max={SHELF_COLS.lg.max}
          onChange={(lg) => change({ ...cols, lg })}
        />
      </div>

      <FontSection />
    </>
  );
}

/**
 * 界面字体
 *
 * 字体包放在**服务端**的字体目录里（zip 或散装 ttf/otf），服务端扫出字族名，
 * 这里挑一个。选择跟着账号同步：字体文件由服务端供给，换设备照样拉得到。
 *
 * 预览要等字体二进制真的注册进 document.fonts 才给 fontFamily ——
 * 没加载就标字体名是假样，用户会照着看不到的效果做决定。
 * 大包（中文常见十几 MB）后台慢慢下，列表先出来，加载完那一行自己变。
 */
function FontSection() {
  const [st, setSt] = useState<FontsStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState(readUiFont);
  const [ready, setReady] = useState<Record<string, boolean>>({});

  const load = useCallback(async (rescan: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const s = rescan ? await rescanFonts() : await getFonts();
      setSt(s);
      void pruneFontCache(s.fonts).catch(() => undefined);
      for (const fam of s.fonts) {
        void loadFamily(fam)
          .then(() => setReady((p) => ({ ...p, [fam.family]: true })))
          .catch(() => undefined); // 拉不动就保持系统字体展示，不算错误
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const pick = (family: string) => {
    setSelected(family);
    setNote(null);
    setUiFont(family);
    void sync.sync();
  };

  const changeDir = async (path: string) => {
    setPicking(false);
    setBusy(true);
    setErr(null);
    try {
      const s = await saveFontDir(path);
      setSt(s);
      setNote('目录已切换，扫到 ' + s.fonts.length + ' 个字族');
      for (const fam of s.fonts) {
        void loadFamily(fam)
          .then(() => setReady((p) => ({ ...p, [fam.family]: true })))
          .catch(() => undefined);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3 className="settings-h">界面字体</h3>
      <p className="settings-note">
        把字体 zip 包（或直接放 ttf/otf/woff2）丢进服务端的字体目录，这里会自动识别。
        选择跟随账号同步到其他设备。只影响界面文字 —— 漫画内容是图片，不动。
      </p>

      {!st && !err && <div className="settings-note">{busy ? '读取中…' : ''}</div>}
      {st && (
        <>
          <div className="settings-rows">
            <button
              type="button"
              className="settings-row"
              aria-pressed={!selected}
              onClick={() => pick('')}
            >
              <span className="settings-row__name">默认（系统字体）</span>
              {!selected && <span className="settings-row__value settings-row__value--accent">使用中</span>}
            </button>
            {st.fonts.map((f) => (
              <button
                key={f.family}
                type="button"
                className="settings-row"
                aria-pressed={selected === f.family}
                onClick={() => pick(f.family)}
                style={ready[f.family] ? { fontFamily: `"${f.family}"` } : undefined}
              >
                <span className="settings-row__name">{f.family}</span>
                <span className="settings-row__value">
                  {ready[f.family]
                    ? f.faces.map((x) => x.subfamily).join(' · ')
                    : '加载预览中…'}
                </span>
                {selected === f.family && (
                  <span className="settings-row__value settings-row__value--accent">使用中</span>
                )}
              </button>
            ))}
          </div>
          {st.fonts.length === 0 && (
            <p className="settings-note">
              这个目录里还没有能识别的字体。往 <code>{st.dir}</code> 放个 zip，再点下面的重新扫描。
            </p>
          )}

          <div className="settings-rows" style={{ marginTop: 10 }}>
            <button type="button" className="settings-row" onClick={() => setPicking(true)}>
              <span className="settings-row__name">字体目录（服务端）</span>
              <span className="settings-row__value">{st.dir}</span>
              <span className="settings-row__value">点击更换 ›</span>
            </button>
          </div>
        </>
      )}

      {err && (
        <div className="notice-err" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
          {err}
        </div>
      )}
      {note && (
        <div className="notice-ok" style={{ marginTop: 10 }}>
          {note}
        </div>
      )}
      {st?.warning && (
        <div className="notice-err" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
          {st.warning}
        </div>
      )}

      <div className="settings-actions">
        <button className="btn btn--ghost" onClick={() => void load(true)} disabled={busy}>
          重新扫描
        </button>
      </div>

      {/* 和缓存页同理：弹层渲染在面板外，别被滚动容器裁掉 */}
      {picking && (
        <DirPicker
          title="选服务端的字体目录"
          startPath={st?.dir || ''}
          onPick={(p) => void changeDir(p)}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
