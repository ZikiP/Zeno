import { useEffect, useRef, useState } from 'react';
import { usePluginManager } from './usePluginManager';
import PluginEditor from './PluginEditor';
import LegalSheet from './LegalSheet';
import PluginList from './PluginList';
import { SyncSheet } from '@/sync/SyncUI';
import { useTheme, THEMES } from '@/hooks/useTheme';
import { IconSun, IconMoon, IconSystem, IconSync } from '@/components/Icons';
import { Sheet } from '@/components/UI';

/**
 * 设置页
 *
 * 只做布局：外观 + 插件管理 + 关于。
 * 插件的增删改查在 usePluginManager，表单在 PluginEditor，免责声明在 LegalSheet。
 */
export default function SettingsPage() {
  const pm = usePluginManager();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void pm.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [showLegal, setShowLegal] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const { resolved } = useTheme();

  return (
    <>
      <header className="topbar">
        <div className="topbar__title">设置</div>
        <div className="topbar__spacer" />
        <button
          className="icon-btn"
          onClick={() => setThemeOpen(true)}
          aria-label="切换主题"
          title="切换主题"
        >
          {resolved === 'light' ? <IconSun /> : <IconMoon />}
        </button>
      </header>

      <main className="main">
        <div className="detail">
          <div className="section-head">
            <h2>外观</h2>
          </div>
          <ThemePicker />

          <div className="section-head" style={{ marginTop: 20 }}>
            <h2>内容源插件</h2>
            <div className="topbar__spacer" />
            <button className="btn btn--sm" onClick={() => fileRef.current?.click()}>
              导入
            </button>
            <button className="btn btn--sm" onClick={pm.startCreate}>
              新建
            </button>
          </div>

          <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.7, margin: '0 0 10px' }}>
            Zeno 不附带任何内容源。插件是一份 JSON 描述文件，说明去哪里、页面长什么样、怎么解析。
            可以从别人那里导入，也可以把自己改好的导出分享。
          </p>

          {pm.message && (
            <div
              className={pm.message.kind === 'ok' ? 'notice-ok' : 'notice-err'}
              style={{ whiteSpace: 'pre-wrap' }}
            >
              {pm.message.text}
            </div>
          )}

          <PluginList manager={pm} onImportClick={() => fileRef.current?.click()} />

          <div className="section-head" style={{ marginTop: 20 }}>
            <h2>关于</h2>
          </div>
          <div className="chapters">
            <button className="chapter-row" onClick={() => setSyncOpen(true)}>
              <IconSync size={18} />
              <span className="chapter-row__name">多端同步</span>
              <span style={{ color: 'var(--text-faint)' }}>›</span>
            </button>
            <button className="chapter-row" onClick={() => setShowLegal(true)}>
              <span className="chapter-row__name">使用须知与免责声明</span>
              <span style={{ color: 'var(--text-faint)' }}>›</span>
            </button>
            <div className="chapter-row">
              <span className="chapter-row__name">版本</span>
              <span style={{ color: 'var(--text-faint)', fontSize: 13 }}>0.6.0</span>
            </div>
          </div>
        </div>
      </main>

      {/* 隐藏的文件选择器 */}
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = ''; // 清掉以便重复选同一文件
          if (f) await pm.importFile(f);
        }}
      />

      {pm.editing && (
        <PluginEditor
          plugin={pm.editing}
          origin={pm.plugins?.find((i) => i.plugin.meta.id === pm.editing!.meta.id)?.origin ?? 'local'}
          onClose={pm.closeEditor}
          onSaved={(name) => void pm.finishSave(name)}
        />
      )}

      {showLegal && <LegalSheet onClose={() => setShowLegal(false)} />}

      {syncOpen && <SyncSheet onClose={() => setSyncOpen(false)} />}

      {themeOpen && (
        <Sheet title="外观" onClose={() => setThemeOpen(false)}>
          <ThemePicker />
        </Sheet>
      )}
    </>
  );
}

/* ── 主题选择器 ─────────────────────────────────── */

export function ThemePicker() {
  const { mode, setTheme } = useTheme();
  const icons = {
    light: <IconSun size={18} />,
    dark: <IconMoon size={18} />,
    system: <IconSystem size={18} />,
  };

  return (
    <div className="theme-picker">
      {THEMES.map((t) => (
        <button
          key={t.key}
          className={`theme-option${mode === t.key ? ' on' : ''}`}
          onClick={() => setTheme(t.key)}
        >
          <span className="theme-option__icon">{icons[t.key]}</span>
          <span className="theme-option__label">{t.label}</span>
          <span className="theme-option__hint">{t.hint}</span>
        </button>
      ))}
    </div>
  );
}
