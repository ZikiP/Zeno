import { useRef } from 'react';
import PluginList from './PluginList';
import PluginEditor from './PluginEditor';
import { usePluginManager } from './usePluginManager';
import { useReloadOnChange } from '@/store/useDataVersion';
import { useUpdateCheck } from './useUpdateCheck';

/**
 * 内容源
 *
 * Zeno 不内置任何内容源：这一栏就是全部的来源管理 —— 导入、新建、启用开关、
 * 编辑、导出、删除。插件是一份 JSON 描述文件，说明去哪里、页面长什么样、怎么解析。
 */
export default function SourcesPanel() {
  const pm = usePluginManager();
  const upd = useUpdateCheck();
  const fileRef = useRef<HTMLInputElement>(null);

  /*
   * 挂载时读一次，之后每次本地数据变更都重读。
   *
   * 只读一次不够：首轮同步可能在这栏已经打开着的时候才把插件写进 IndexedDB，
   * 那样列表会一直停在「还没有安装任何插件」，而发现页明明已经有源可用了。
   */
  useReloadOnChange(pm.reload);

  return (
    <>
      <p className="settings-note">
        装好插件后，抓取白名单会自动包含它用到的域名，不用去改服务端配置。
        <br />
        <em>
          开关决定这个源要不要用，可以同时启用多个：书架把它们的书合在一起，
          发现页用顶部的切换器换站，跨源搜索默认把所有已启用的源都搜一遍。
          停用只是藏起来，书架和缓存都还在，重新打开就回来。
        </em>
      </p>

      <div className="settings-actions" style={{ marginTop: 0, marginBottom: 12 }}>
        <button className="btn btn--sm" onClick={() => fileRef.current?.click()}>
          导入
        </button>
        <button className="btn btn--sm btn--ghost" onClick={pm.startCreate}>
          新建
        </button>
      </div>

      {/*
        追更：服务端定时抓一轮才知道书架上哪本有新章，这里给一个手动入口。
        摆在"立即检查"这一档上而不是单独一栏，是因为它就是内容源的一件事。
      */}
      <div className="settings-actions" style={{ marginTop: 0, marginBottom: 12 }}>
        <button className="btn btn--sm btn--ghost" onClick={upd.run} disabled={upd.busy}>
          {upd.busy ? '检查中…' : '立即检查更新'}
        </button>
        {upd.result && <span className="settings-note">{upd.result}</span>}
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
