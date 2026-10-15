import { useEffect, useState } from 'react';
import { formatAgo } from '@/store/utils';
import { sync, type SyncState } from '@/sync/client';

/**
 * 同步状态条。放在顶栏下方，让用户随时知道「数据同步了没」。
 *
 * 配置弹层在 SyncSheet.tsx —— 这两个只是同一件事的两面，不再放一个文件里，
 * 合起来早就过了组件的 250 行上限。
 */
export default function SyncBar({ onConfigure }: { onConfigure?: () => void }) {
  const [s, setS] = useState<SyncState>(sync.getState());

  useEffect(() => sync.subscribe(setS), []);

  // 没配置服务端就不显示 —— 不打扰只用本地的用户
  if (!s.endpoint) return null;

  if (s.syncing) {
    return (
      <button className="sync-bar sync-bar--busy" onClick={onConfigure}>
        <span className="sync-bar__dot" />
        同步中…
      </button>
    );
  }

  if (!s.online) {
    return (
      <button className="sync-bar sync-bar--error" onClick={onConfigure}>
        <span className="sync-bar__dot" />
        离线 · 连不上同步服务
      </button>
    );
  }

  return (
    <button className="sync-bar" onClick={onConfigure} title="点击查看同步设置">
      <span className="sync-bar__dot sync-bar__dot--ok" />
      已同步
      {s.lastSyncAt && ` · ${formatAgo(s.lastSyncAt)}`}
    </button>
  );
}
