import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deletePlugin,
  getActivePlugin,
  listPlugins,
  newPluginTemplate,
  savePlugin,
  setActivePlugin,
  type InstalledPlugin,
} from '@/store/db';
import { PLUGIN_FORMAT, pluginHosts, validatePlugin, type Plugin } from '@/site/types';
import { useTheme, THEMES } from '@/hooks/useTheme';
import {
  IconDownload,
  IconExport,
  IconMoon,
  IconPlus,
  IconSun,
  IconSystem,
} from '@/components/Icons';
import { Sheet } from '@/components/UI';

export default function SettingsPage() {
  const [items, setItems] = useState<InstalledPlugin[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Plugin | null>(null);
  const [showLegal, setShowLegal] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const [all, active] = await Promise.all([listPlugins(), getActivePlugin()]);
    setItems(all);
    setActiveId(active?.meta.id ?? null);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /* ── 导入 ─────────────────────────────────────── */
  const onImportFile = async (file: File) => {
    setMsg(null);
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      setMsg({ kind: 'err', text: '文件不是合法 JSON' });
      return;
    }

    const errs = validatePlugin(json);
    if (errs.length > 0) {
      setMsg({ kind: 'err', text: `插件校验未通过：\n· ${errs.join('\n· ')}` });
      return;
    }

    const p = json as Plugin;
    const exists = items?.some((i) => i.plugin.meta.id === p.meta.id);
    await savePlugin({
      plugin: p,
      installedAt: Date.now(),
      origin: 'imported',
    });
    await setActivePlugin(p.meta.id);
    await reload();
    setMsg({
      kind: 'ok',
      text: exists
        ? `已更新插件「${p.meta.name}」并设为当前`
        : `已导入插件「${p.meta.name}」并设为当前`,
    });
  };

  /* ── 导出 ─────────────────────────────────────── */
  const onExport = (p: Plugin) => {
    const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zeno-plugin-${p.meta.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
          <ThemeIcon />
        </button>
      </header>

      <main className="main">
        <div className="detail">
          {/* 主题 */}
          <div className="section-head">
            <h2>外观</h2>
          </div>
          <ThemePicker />

          {/* 插件 */}
          <div className="section-head" style={{ marginTop: 20 }}>
            <h2>内容源插件</h2>
            <div className="topbar__spacer" />
            <button className="btn btn--sm" onClick={() => fileRef.current?.click()}>
              <IconDownload size={15} />
              导入
            </button>
            <button className="btn btn--sm" onClick={() => setEditing(newPluginTemplate('新建插件'))}>
              <IconPlus size={15} />
              新建
            </button>
          </div>

          <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.7, margin: '0 0 10px' }}>
            Zeno 不附带任何内容源。插件是一份 JSON 描述文件，说明去哪里、页面长什么样、怎么解析。
            可以从别人那里导入，也可以把自己改好的导出分享。
          </p>

          {msg && (
            <div
              className={msg.kind === 'ok' ? 'notice-ok' : 'notice-err'}
              style={{ whiteSpace: 'pre-wrap' }}
            >
              {msg.text}
            </div>
          )}

          {items === null ? (
            <div className="loading">读取中</div>
          ) : items.length === 0 ? (
            <div className="empty">
              <div>还没有安装任何插件</div>
              <div style={{ fontSize: 12 }}>导入一个 .json 插件文件，或自己新建一个</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button className="btn btn--sm" onClick={() => fileRef.current?.click()}>
                  <IconDownload size={15} />
                  导入插件
                </button>
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() => setEditing(newPluginTemplate('新建插件'))}
                >
                  新建
                </button>
              </div>
            </div>
          ) : (
            <div className="chapters">
              {items.map((it) => {
                const p = it.plugin;
                const isActive = p.meta.id === activeId;
                return (
                  <div key={p.meta.id} className="chapter-row" style={{ flexWrap: 'wrap' }}>
                    <button
                      className="chapter-row__name"
                      style={{ textAlign: 'left' }}
                      onClick={async () => {
                        await setActivePlugin(p.meta.id);
                        await reload();
                      }}
                      title={isActive ? '当前使用中' : '点击切换到此插件'}
                    >
                      <span style={{ fontSize: 15 }}>{p.meta.icon ?? '📄'} </span>
                      {p.meta.name}
                      <span style={{ color: 'var(--text-faint)', fontSize: 12, marginLeft: 8 }}>
                        {p.entry.replace(/^https?:\/\//, '')}
                      </span>
                      {p.meta.author && (
                        <span style={{ color: 'var(--text-faint)', fontSize: 11, marginLeft: 6 }}>
                          by {p.meta.author}
                        </span>
                      )}
                    </button>

                    {isActive && <span className="chapter-row__badge badge-done">使用中</span>}

                    <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
                      <button
                        className="icon-btn"
                        onClick={() => onExport(p)}
                        title="导出为 JSON 文件"
                        aria-label="导出"
                      >
                        <IconExport size={17} />
                      </button>
                      <button
                        className="icon-btn"
                        onClick={() => setEditing(p)}
                        title="编辑"
                        aria-label="编辑"
                      >
                        编辑
                      </button>
                      <button
                        className="icon-btn"
                        aria-label="删除"
                        title="删除"
                        onClick={async () => {
                          if (!confirm(`删除插件「${p.meta.name}」？\n该插件的书架与离线缓存会一并清除。`)) {
                            return;
                          }
                          await deletePlugin(p.meta.id);
                          await reload();
                        }}
                      >
                        删除
                      </button>
                    </div>

                    {p.meta.description && (
                      <div
                        style={{
                          width: '100%',
                          fontSize: 12,
                          color: 'var(--text-faint)',
                          paddingLeft: 4,
                          marginTop: 2,
                        }}
                      >
                        {p.meta.description}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* 关于 */}
          <div className="section-head" style={{ marginTop: 20 }}>
            <h2>关于</h2>
          </div>
          <div className="chapters">
            <button className="chapter-row" onClick={() => setShowLegal(true)}>
              <span className="chapter-row__name">使用须知与免责声明</span>
              <span style={{ color: 'var(--text-faint)' }}>›</span>
            </button>
            <div className="chapter-row">
              <span className="chapter-row__name">版本</span>
              <span style={{ color: 'var(--text-faint)', fontSize: 13 }}>0.3.0</span>
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
          e.target.value = '';
          if (f) await onImportFile(f);
        }}
      />

      {editing && (
        <PluginEditor
          plugin={editing}
          origin={items?.find((i) => i.plugin.meta.id === editing.meta.id)?.origin ?? 'local'}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
            setMsg({ kind: 'ok', text: `插件「${editing.meta.name}」已保存并设为当前` });
          }}
        />
      )}

      {showLegal && <LegalSheet onClose={() => setShowLegal(false)} />}

      {themeOpen && (
        <Sheet title="外观" onClose={() => setThemeOpen(false)}>
          <ThemePicker />
        </Sheet>
      )}
    </>
  );
}

/* ── 主题选择 ─────────────────────────────────────── */

function ThemeIcon() {
  const { resolved } = useTheme();
  return resolved === 'light' ? <IconSun /> : <IconMoon />;
}

function ThemePicker() {
  const { mode, setTheme } = useTheme();
  return (
    <div className="theme-picker">
      {THEMES.map((t) => (
        <button
          key={t.key}
          className={`theme-option${mode === t.key ? ' on' : ''}`}
          onClick={() => setTheme(t.key)}
        >
          <span className="theme-option__icon">
            {t.key === 'light' ? <IconSun size={18} /> : t.key === 'dark' ? <IconMoon size={18} /> : <IconSystem size={18} />}
          </span>
          <span className="theme-option__label">{t.label}</span>
          <span className="theme-option__hint">{t.hint}</span>
        </button>
      ))}
    </div>
  );
}

/* ── 插件编辑器 ───────────────────────────────────── */

function PluginEditor({
  plugin,
  origin,
  onClose,
  onSaved,
}: {
  plugin: Plugin;
  origin: 'local' | 'imported';
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Plugin>(plugin);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const set = <K extends keyof Plugin>(k: K, v: Plugin[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setMeta = (k: keyof Plugin['meta'], v: string) =>
    setDraft((d) => ({ ...d, meta: { ...d.meta, [k]: v } }));
  const setUrl = (k: keyof Plugin['urls'], v: string) =>
    setDraft((d) => ({ ...d, urls: { ...d.urls, [k]: v } }));
  const setParse = (k: keyof Plugin['parse'], v: unknown) =>
    setDraft((d) => ({ ...d, parse: { ...d.parse, [k]: v } }));

  const errors = validatePlugin(draft);
  const hosts = pluginHosts(draft);

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const { listComics } = await import('@/site/engine');
      const list = await listComics(draft);
      setTestMsg(
        list.length > 0
          ? `成功，解析到 ${list.length} 部。示例：${list[0].title}`
          : '请求成功但一条都没解析出来。检查「卡片起始片段」是否填了标签开头，以及 slug 正则是否含捕获组。',
      );
    } catch (e) {
      setTestMsg(`失败：${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Sheet title={origin === 'imported' ? '编辑插件' : '新建插件'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {origin === 'imported' && (
          <div className="notice-ok" style={{ padding: 8, fontSize: 12 }}>
            这是导入的插件（{draft.meta.author ?? '未署名'}）。修改后导出即可分享你的版本。
          </div>
        )}

        <Field label="插件名称" value={draft.meta.name} onChange={(v) => setMeta('name', v)} />
        <Field
          label="图标"
          hint="一个 emoji，或 http(s) 图片地址"
          value={draft.meta.icon ?? ''}
          onChange={(v) => setMeta('icon', v)}
          placeholder="📚"
        />
        <Field
          label="一句话描述"
          value={draft.meta.description ?? ''}
          onChange={(v) => setMeta('description', v)}
        />
        <Field label="作者" value={draft.meta.author ?? ''} onChange={(v) => setMeta('author', v)} />
        <Field
          label="标识 id"
          hint={`插件的唯一标识，导入他人插件时用于判重。导出文件名为 zeno-plugin-${draft.meta.id}.json`}
          value={draft.meta.id}
          onChange={(v) => setMeta('id', v)}
        />

        <Divider text="地址" />

        <Field
          label="入口地址"
          hint="https:// 开头，不要带路径"
          value={draft.entry}
          onChange={(v) => set('entry', v)}
          placeholder="https://example.com"
        />
        <Field
          label="章节页地址"
          hint="留空则与入口相同"
          value={draft.chapterHost ?? ''}
          onChange={(v) => set('chapterHost', v)}
        />

        <Divider text="页面 URL 模板（ {变量} 会被替换）" />

        <Field label="搜索" value={draft.urls.search} onChange={(v) => setUrl('search', v)} />
        <Field label="分类列表" value={draft.urls.classify} onChange={(v) => setUrl('classify', v)} />
        <Field label="漫画详情" value={draft.urls.detail} onChange={(v) => setUrl('detail', v)} />
        <Field label="章节正文" value={draft.urls.chapter} onChange={(v) => setUrl('chapter', v)} />

        <Divider text="HTML 解析规则" />

        <Field
          label="卡片起始片段"
          hint='必须是标签开头，如 <div class="comic-card。填 CSS 选择器会连 style 里的规则一起切进来。'
          value={draft.parse.card}
          onChange={(v) => setParse('card', v)}
        />
        <Field
          label="slug 提取正则"
          hint='需含一个捕获组，如 href="/comic/([^"]+)"'
          value={draft.parse.slugFrom}
          onChange={(v) => setParse('slugFrom', v)}
        />
        <Field
          label="标题来源"
          hint="属性名（如 title）或标签名（如 h3）"
          value={'attr' in draft.parse.title ? draft.parse.title.attr : draft.parse.title.tag}
          onChange={(v) => setParse('title', v.startsWith('<') ? { tag: v } : { attr: v })}
        />
        <Field label="封面提取正则" value={draft.parse.cover} onChange={(v) => setParse('cover', v)} />
        <Field
          label="章节条目标识"
          hint='形如 class="chapter-item"'
          value={draft.parse.chapterItem}
          onChange={(v) => setParse('chapterItem', v)}
        />
        <Field
          label="章节 id 提取正则"
          hint="需两个捕获组：第 1 组=分区号，第 2 组=章节序号。参数式 URL 填 section_slot=(\\d+)&chapter_slot=(\\d+)，路径式填 /(\\d+)_(\\d+)\\.html"
          value={draft.parse.chapterIdFrom}
          onChange={(v) => setParse('chapterIdFrom', v)}
        />
        <Field
          label="图片真实地址所在属性"
          hint="很多站点 src 里是框架绑定符号，真实地址在 data-src"
          value={draft.parse.imageAttr}
          onChange={(v) => setParse('imageAttr', v)}
        />
        <Field
          label="图片域名后缀"
          hint="逗号分隔。用于代理白名单提示与离线缓存"
          value={draft.imageHosts.join(',')}
          onChange={(v) =>
            set('imageHosts', v.split(',').map((s) => s.trim()).filter(Boolean))
          }
        />

        {hosts.length > 0 && (
          <div className="notice-ok" style={{ padding: 10, fontSize: 12, lineHeight: 1.6 }}>
            启动代理时需要放行这些域名：
            <br />
            <code style={{ fontSize: 11, wordBreak: 'break-all' }}>
              ALLOWED_HOSTS={hosts.join(',')}
            </code>
          </div>
        )}

        {errors.length > 0 && (
          <div className="notice-err">
            {errors.map((e) => (
              <div key={e}>· {e}</div>
            ))}
          </div>
        )}

        {testMsg && (
          <div
            className={testMsg.startsWith('成功') ? 'notice-ok' : 'notice-err'}
            style={{ lineHeight: 1.6 }}
          >
            {testMsg}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--ghost" onClick={test} disabled={testing || errors.length > 0}>
            {testing ? '测试中…' : '测试解析'}
          </button>
          <div style={{ flex: 1 }} />
          <button
            className="btn"
            disabled={errors.length > 0 || !draft.meta.name.trim()}
            onClick={async () => {
              await savePlugin({ plugin: draft, installedAt: Date.now(), origin });
              await setActivePlugin(draft.meta.id);
              onSaved();
            }}
          >
            保存并启用
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function Divider({ text }: { text: string }) {
  return (
    <div style={{ margin: '6px 0 2px' }}>
      <div style={{ height: 1, background: 'var(--border)', marginBottom: 8 }} />
      <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{text}</div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 38,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--text)',
  fontSize: 13,
  outline: 'none',
};

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 13, marginBottom: 4 }}>{label}</div>
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4, lineHeight: 1.5 }}>
          {hint}
        </div>
      )}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={inputStyle}
      />
    </label>
  );
}

/* ── 免责声明 ─────────────────────────────────────── */

function LegalSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="使用须知" onClose={onClose}>
      <div style={{ fontSize: 13, lineHeight: 1.85, color: 'var(--text-dim)' }}>
        <p style={{ marginTop: 0 }}>
          <strong style={{ color: 'var(--text)' }}>Zeno 是一个技术工具</strong>
          ，只提供「把网页内容呈现得更干净」的通用能力。它不内置、不推荐、不分发任何内容源。
        </p>
        <p>
          <strong style={{ color: 'var(--text)' }}>版权</strong>
          ：通过本工具访问、下载或缓存的任何内容，其著作权归各自权利人所有。
          相关责任由使用者自行承担。请遵守目标站点的服务条款，并遵守你所在地区的法律法规。
          仅供个人学习与非商业用途。
        </p>
        <p>
          <strong style={{ color: 'var(--text)' }}>插件由第三方提供</strong>
          ：插件是他人编写的解析规则，不经本项目审核与背书。
          导入插件即表示你自行判断并接受其内容与用途。插件作者不因使用本项目而获得任何授权或认可。
        </p>
        <p>
          <strong style={{ color: 'var(--text)' }}>不提供内容</strong>
          ：本项目仓库中不包含任何漫画内容、图片或默认插件。
        </p>
        <p>
          <strong style={{ color: 'var(--text)' }}>无担保</strong>
          ：代码按 MIT 协议提供，不作任何明示或暗示担保。
          目标站点随时可能改版，届时插件的解析规则可能失效。
        </p>
      </div>
    </Sheet>
  );
}

export { PLUGIN_FORMAT };
