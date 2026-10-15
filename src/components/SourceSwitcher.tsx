import { usePlugin } from '@/store/PluginContext';

/**
 * 发现页的内容源切换器。
 *
 * 只有一个（或零个）源时整条不出现：一排 chip 摆在那儿只会让人以为还有别的可点。
 * 切换只改"这台设备正在看哪个源"，写在 localStorage 里刻意不同步 ——
 * 手机上在看拷貝漫畫，不该把平板上的发现页也一起换掉。
 */
export default function SourceSwitcher({ onPick }: { onPick: () => void }) {
  const { enabled, browseId, setBrowse } = usePlugin();

  if (enabled.length < 2) return null;

  return (
    <div className="filters source-switch" role="group" aria-label="内容源">
      {enabled.map((p) => (
        <button
          key={p.meta.id}
          className={`chip${p.meta.id === browseId ? ' on' : ''}`}
          aria-pressed={p.meta.id === browseId}
          onClick={() => {
            setBrowse(p.meta.id);
            onPick();
          }}
        >
          {p.meta.icon ?? '📄'} {p.meta.name}
        </button>
      ))}
    </div>
  );
}
