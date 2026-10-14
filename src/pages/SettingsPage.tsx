import { useCallback, useEffect, useState } from 'react';
import {
  deleteSite,
  getActiveSite,
  listSites,
  newSiteTemplate,
  saveSite,
  setActiveSite,
} from '@/store/db';
import { validateSite, type SiteConfig } from '@/site/types';
import { IconPlus, IconSettings } from '@/components/Icons';
import { Sheet } from '@/components/UI';

export default function SettingsPage() {
  const [sites, setSites] = useState<SiteConfig[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<SiteConfig | null>(null);
  const [showLegal, setShowLegal] = useState(false);

  const reload = useCallback(async () => {
    const [all, active] = await Promise.all([listSites(), getActiveSite()]);
    setSites(all);
    setActiveId(active?.id ?? null);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <>
      <header className="topbar">
        <div className="topbar__title">设置</div>
        <div className="topbar__spacer" />
        <button className="icon-btn" onClick={() => setShowLegal(true)} aria-label="使用须知">
          <IconSettings />
        </button>
      </header>

      <main className="main">
        <div className="detail">
          <div className="section-head">
            <h2>内容源</h2>
            <div className="topbar__spacer" />
            <button
              className="btn btn--sm"
              onClick={() => setEditing(newSiteTemplate('新站点'))}
            >
              <IconPlus size={15} />
              添加站点
            </button>
          </div>

          <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.7, margin: 0 }}>
            Zeno 不内置任何站点。请自行填写要访问的站点及其页面解析规则 ——
            配置只保存在你自己的浏览器里，不会同步到任何地方。
          </p>

          {sites === null ? (
            <div className="loading">读取中</div>
          ) : sites.length === 0 ? (
            <div className="empty">
              <div>还没有配置站点</div>
              <button
                className="btn btn--sm"
                onClick={() => setEditing(newSiteTemplate('新站点'))}
              >
                添加第一个站点
              </button>
            </div>
          ) : (
            <div className="chapters">
              {sites.map((s) => (
                <div key={s.id} className="chapter-row">
                  <button
                    className="chapter-row__name"
                    style={{ textAlign: 'left' }}
                    onClick={async () => {
                      await setActiveSite(s.id);
                      await reload();
                    }}
                  >
                    {s.name}
                    <span style={{ color: 'var(--text-faint)', fontSize: 12, marginLeft: 8 }}>
                      {s.entry}
                    </span>
                  </button>
                  {s.id === activeId && (
                    <span className="chapter-row__badge badge-done">使用中</span>
                  )}
                  <button className="icon-btn" onClick={() => setEditing(s)} aria-label="编辑">
                    编辑
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="删除"
                    onClick={async () => {
                      if (!confirm(`删除站点「${s.name}」？\n该站的书架与离线缓存会一并清除。`)) {
                        return;
                      }
                      await deleteSite(s.id);
                      await reload();
                    }}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}

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
              <span style={{ color: 'var(--text-faint)', fontSize: 13 }}>0.2.0</span>
            </div>
          </div>
        </div>
      </main>

      {editing && (
        <SiteEditor
          site={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}

      {showLegal && <LegalSheet onClose={() => setShowLegal(false)} />}
    </>
  );
}

/* ── 站点编辑弹层 ─────────────────────────────────── */

function SiteEditor({
  site,
  onClose,
  onSaved,
}: {
  site: SiteConfig;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<SiteConfig>(site);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const set = <K extends keyof SiteConfig>(k: K, v: SiteConfig[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const setUrl = (k: keyof SiteConfig['urls'], v: string) =>
    setDraft((d) => ({ ...d, urls: { ...d.urls, [k]: v } }));

  const setParse = (k: keyof SiteConfig['parse'], v: unknown) =>
    setDraft((d) => ({ ...d, parse: { ...d.parse, [k]: v } }));

  const errors = validateSite(draft);

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const { listComics } = await import('@/site/engine');
      const list = await listComics(draft);
      setTestMsg(
        list.length > 0
          ? `成功，解析到 ${list.length} 部。标题示例：${list[0].title}`
          : '请求成功但一条都没解析出来，检查「卡片起始片段」和「slug 提取规则」',
      );
    } catch (e) {
      setTestMsg(`失败：${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Sheet title={site.name ? '编辑站点' : '添加站点'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field
          label="站点名称"
          value={draft.name}
          onChange={(v) => set('name', v)}
          placeholder="我的站点"
        />

        <Field
          label="站点地址"
          hint="https:// 开头，不要带路径"
          value={draft.entry}
          onChange={(v) => set('entry', v)}
          placeholder="https://example.com"
        />

        <Field
          label="章节页域名"
          hint="留空则与站点地址相同"
          value={draft.chapterHost ?? ''}
          onChange={(v) => set('chapterHost', v)}
          placeholder="留空 = 同站点"
        />

        <Divider text="页面 URL 模板（ {变量} 会被替换）" />

        <Field label="搜索" value={draft.urls.search} onChange={(v) => setUrl('search', v)} />
        <Field label="分类列表" value={draft.urls.classify} onChange={(v) => setUrl('classify', v)} />
        <Field label="漫画详情" value={draft.urls.detail} onChange={(v) => setUrl('detail', v)} />
        <Field label="章节正文" value={draft.urls.chapter} onChange={(v) => setUrl('chapter', v)} />

        <Divider text="HTML 解析规则" />

        <Field
          label="卡片起始片段"
          hint='形如 <div class="comic-card'
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
          hint="填属性名（如 title）或标签名（如 h3）"
          value={'attr' in draft.parse.title ? draft.parse.title.attr : draft.parse.title.tag}
          onChange={(v) =>
            setParse('title', v.startsWith('<') ? { tag: v } : { attr: v })
          }
        />

        <Field
          label="封面提取正则"
          value={draft.parse.cover}
          onChange={(v) => setParse('cover', v)}
        />

        <Field
          label="章节条目标识"
          hint='形如 class="chapter-item"'
          value={draft.parse.chapterItem}
          onChange={(v) => setParse('chapterItem', v)}
        />

        <Field
          label="图片真实地址所在属性"
          hint="很多站点 src 里是框架绑定符号，真实地址在 data-src"
          value={draft.parse.imageAttr}
          onChange={(v) => setParse('imageAttr', v)}
          placeholder="data-src"
        />

        <Field
          label="图片域名后缀"
          hint="逗号分隔，用于离线缓存规则"
          value={draft.imageHosts.join(',')}
          onChange={(v) =>
            set(
              'imageHosts',
              v
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          placeholder="example-cdn.com"
        />

        {errors.length > 0 && (
          <div className="error-box">
            {errors.map((e) => (
              <div key={e}>· {e}</div>
            ))}
          </div>
        )}

        {testMsg && (
          <div
            style={{
              padding: 10,
              borderRadius: 8,
              fontSize: 13,
              lineHeight: 1.6,
              background: testMsg.startsWith('成功')
                ? 'rgba(16,185,129,.12)'
                : 'rgba(248,113,113,.1)',
              color: testMsg.startsWith('成功') ? '#34d399' : '#fca5a5',
            }}
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
            disabled={errors.length > 0 || !draft.name.trim()}
            onClick={async () => {
              await saveSite(draft);
              await setActiveSite(draft.id);
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
          ：漫画作品的著作权归各自权利人所有。使用本工具访问、下载或缓存任何内容，
          权利归属与相应责任由使用者自行承担。请遵守目标站点的服务条款，
          并遵守你所在地区的法律法规。仅供个人学习与非商业用途。
        </p>

        <p>
          <strong style={{ color: 'var(--text)' }}>不提供内容</strong>
          ：本项目仓库中不包含任何漫画内容、图片、站点配置或默认站点列表。
          站点信息由使用者自行录入，只保存在本地浏览器。
        </p>

        <p>
          <strong style={{ color: 'var(--text)' }}>按需遵守</strong>
          ：若某站点的条款禁止自动化访问，请勿使用本工具访问该站点。
          本工具不提供绕过访问控制、验证码破解或反爬对抗的功能。
        </p>

        <p>
          <strong style={{ color: 'var(--text)' }}>无担保</strong>
          ：代码按 MIT 协议提供，不作任何明示或暗示担保。
          目标站点随时可能改版，届时解析规则可能失效。
        </p>
      </div>
    </Sheet>
  );
}
