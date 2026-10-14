import { useState } from 'react';
import type { Plugin } from '@/site/types';
import { pluginHosts, validatePlugin } from '@/site/validate';
import { savePlugin, setActivePlugin } from '@/store/plugins';
import { notifyPluginChanged } from '@/store/PluginContext';
import { Sheet } from '@/components/UI';
import { Divider, Field, FieldGroup } from '@/components/FormKit';

/**
 * 插件编辑表单
 *
 * 独立成组件是因为它自成一块复杂表单（300+ 行 JSX），
 * 且与设置页的布局逻辑完全无关。
 */
export default function PluginEditor({
  plugin,
  origin,
  onClose,
  onSaved,
}: {
  plugin: Plugin;
  origin: 'local' | 'imported';
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const [draft, setDraft] = useState<Plugin>(plugin);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const errors = validatePlugin(draft);
  const hosts = pluginHosts(draft);

  /**
   * 测试解析。
   * 用搜索模式而不是分类模式 —— 一次能验证两个 URL 模板，
   * 而搜索结果页的卡片结构与列表页一致，正好复用来测解析规则。
   */
  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const { listComics } = await import('@/site/engine');
      const result = await listComics(draft, { query: 'test' });
      setTestMsg(
        result.exact && result.comics.length > 0
          ? `成功，搜索「test」解析到 ${result.comics.length} 部。示例：${result.comics[0].title}`
          : '请求成功但没解析到内容。请检查：\n· 搜索 URL 模板是否正确\n· 卡片起始片段是否填了标签开头（不能填 CSS 选择器）\n· slug 正则是否含捕获组',
      );
    } catch (e) {
      setTestMsg(`失败：${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Sheet title={origin === 'imported' ? '编辑插件' : '新建插件'} onClose={onClose}>
      <FieldGroup>
        {origin === 'imported' && (
          <div className="notice-ok" style={{ padding: 8, fontSize: 12 }}>
            这是导入的插件（{draft.meta.author ?? '未署名'}）。修改后导出即可分享你的版本。
          </div>
        )}

        {/* ── 基本信息 ── */}
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
          hint={`唯一标识，导入他人插件时用于判重。导出文件名为 zeno-plugin-${draft.meta.id}.json`}
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
          label="搜索无结果特征（可选）"
          hint="有些站点查不到时不返回空列表而是塞推荐，且不留任何标记。这种情况请填一个能识别它的正则；能明确写「未找到」的站点已内置识别，无需填写"
          value={draft.parse.noResultPattern ?? ''}
          onChange={(v) => setParse('noResultPattern', v || undefined)}
          placeholder={'<div class=&quot;result-list&quot;></div>'}
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
            保存后服务端会自动放行这些域名，无需其他配置：
            <br />
            <code style={{ fontSize: 11, wordBreak: 'break-all' }}>
              {hosts.join(', ')}
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
            style={{ lineHeight: 1.6, whiteSpace: 'pre-wrap' }}
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
              notifyPluginChanged();
              onSaved(draft.meta.name);
            }}
          >
            保存并启用
          </button>
        </div>
      </FieldGroup>
    </Sheet>
  );

  /* ── 局部更新辅助 ── */

  function set<K extends keyof Plugin>(k: K, v: Plugin[K]) {
    setDraft((d) => ({ ...d, [k]: v }));
  }
  function setMeta<K extends keyof Plugin['meta']>(k: K, v: string) {
    setDraft((d) => ({ ...d, meta: { ...d.meta, [k]: v } }));
  }
  function setUrl(k: keyof Plugin['urls'], v: string) {
    setDraft((d) => ({ ...d, urls: { ...d.urls, [k]: v } }));
  }
  function setParse(k: keyof Plugin['parse'], v: unknown) {
    setDraft((d) => ({ ...d, parse: { ...d.parse, [k]: v } }));
  }
}