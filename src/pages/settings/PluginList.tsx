import type { PluginManager } from './usePluginManager';
import type { Plugin } from '@/site/types';
import { IconDownload, IconExport, IconPlus } from '@/components/Icons';

/** 已安装插件的列表（空态、卡片、导出/编辑/删除） */
export default function PluginList({
  manager,
  onImportClick,
}: {
  manager: PluginManager;
  onImportClick: () => void;
}) {
  const { plugins, activeId } = manager;

  if (plugins === null) {
    return <div className="loading">读取中</div>;
  }

  if (plugins.length === 0) {
    return (
      <div className="empty">
        <div>还没有安装任何插件</div>
        <div style={{ fontSize: 12 }}>导入一个 .json 插件文件，或自己新建一个</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button className="btn btn--sm" onClick={onImportClick}>
            <IconDownload size={15} />
            导入插件
          </button>
          <button className="btn btn--sm btn--ghost" onClick={manager.startCreate}>
            <IconPlus size={15} />
            新建
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="chapters">
      {plugins.map((it) => (
        <PluginRow
          key={it.plugin.meta.id}
          plugin={it.plugin}
          origin={it.origin}
          active={it.plugin.meta.id === activeId}
          manager={manager}
        />
      ))}
    </div>
  );
}

function PluginRow({
  plugin,
  origin,
  active,
  manager,
}: {
  plugin: Plugin;
  origin: 'local' | 'imported';
  active: boolean;
  manager: PluginManager;
}) {
  return (
    <div className="chapter-row" style={{ flexWrap: 'wrap' }}>
      <button
        className="chapter-row__name"
        style={{ textAlign: 'left' }}
        onClick={() => void manager.switchTo(plugin.meta.id)}
        title={active ? '当前使用中' : '点击切换到此插件'}
      >
        <span style={{ fontSize: 15 }}>{plugin.meta.icon ?? '📄'} </span>
        {plugin.meta.name}
        <span style={{ color: 'var(--text-faint)', fontSize: 12, marginLeft: 8 }}>
          {plugin.entry.replace(/^https?:\/\//, '')}
        </span>
        {plugin.meta.author && (
          <span style={{ color: 'var(--text-faint)', fontSize: 11, marginLeft: 6 }}>
            by {plugin.meta.author}
          </span>
        )}
        {!active && origin === 'imported' && (
          <span style={{ color: 'var(--text-faint)', fontSize: 11, marginLeft: 6 }}>
            导入
          </span>
        )}
      </button>

      {active && <span className="chapter-row__badge badge-done">使用中</span>}

      <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
        <button
          className="icon-btn"
          onClick={() => manager.exportPlugin(plugin)}
          title="导出为 JSON 文件"
          aria-label="导出"
        >
          <IconExport size={17} />
        </button>
        <button
          className="icon-btn"
          onClick={() => manager.startEdit(plugin)}
          title="编辑"
          aria-label="编辑"
        >
          编辑
        </button>
        <button
          className="icon-btn"
          aria-label="删除"
          title="删除"
          onClick={() => void manager.remove(plugin)}
        >
          删除
        </button>
      </div>

      {plugin.meta.description && (
        <div
          style={{
            width: '100%',
            fontSize: 12,
            color: 'var(--text-faint)',
            paddingLeft: 4,
            marginTop: 2,
          }}
        >
          {plugin.meta.description}
        </div>
      )}
    </div>
  );
}
