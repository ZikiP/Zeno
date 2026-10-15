import { useEffect, useRef } from 'react';
import PluginList from './PluginList';
import PluginEditor from './PluginEditor';
import { usePluginManager } from './usePluginManager';

/**
 * 内容源
 *
 * Zeno 不内置任何内容源：这一栏就是全部的来源管理 —— 导入、新建、切换激活、
 * 编辑、导出、删除。插件是一份 JSON 描述文件，说明去哪里、页面长什么样、怎么解析。
 */
export default function SourcesPanel() {
  const pm = usePluginManager();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void pm.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <p className="settings-note">
        装好插件后，抓取白名单会自动包含它用到的域名，不用去改服务端配置。
        <br />
        <em>发现页与搜索页用的是当前激活的那个源；书架和详情页跟着地址走，能同时读多个源。</em>
      </p>

      <div className="settings-actions" style={{ marginTop: 0, marginBottom: 12 }}>
        <button className="btn btn--sm" onClick={() => fileRef.current?.click()}>
          导入
        </button>
        <button className="btn btn--sm btn--ghost" onClick={pm.startCreate}>
          新建
        </button>
      </div>

      {pm.message && (
        <div
          className={pm.message.kind === 'ok' ? 'notice-ok' : 'notice-err'}
          style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}
        >
          {pm.message.text}
        </div>
      )}

      <PluginList manager={pm} onImportClick={() => fileRef.current?.click()} />

      {/* 隐藏的文件选择器。选完要清掉 value，否则重复选同一个文件不再触发 change */}
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
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
    </>
  );
}
