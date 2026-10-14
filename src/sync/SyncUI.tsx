import { useEffect, useState } from 'react';
import { sync, type SyncState } from '@/sync/client';

/** 同步状态条。放在顶栏下方，让用户随时知道「数据同步了没」 */
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
      {s.lastSyncAt && ` · ${relativeTime(s.lastSyncAt)}`}
    </button>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 同步配置弹层 */
export function SyncSheet({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<SyncState>(sync.getState());
  const [endpoint, setEndpoint] = useState(s.endpoint);
  const [token, setToken] = useState('');

  useEffect(() => sync.subscribe(setS), []);

  /** 立即同步：先保存配置（否则改动不生效），再探测、推送 */
  const syncNow = async () => {
    sync.applyConfig({ endpoint: endpoint.trim(), token: token.trim() || undefined });
    await sync.probe();
    await sync.sync();
  };

  const save = async () => {
    await syncNow();
    onClose();
  };

  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer__head">
          <div className="drawer__title">多端同步</div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div style={{ padding: '14px 16px 16px' }}>
          <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.7, margin: '0 0 14px' }}>
            填写服务端地址后，书架、阅读进度、书签笔记、插件与偏好会在
            手机、平板、电脑之间自动同步。
            <br />
            <span style={{ color: 'var(--text-faint)' }}>
              离线时照常本地可用，联网后自动补同步。
            </span>
          </p>

          <label style={{ display: 'block', marginBottom: 12 }}>
            <div style={{ fontSize: 13, marginBottom: 4 }}>服务端地址</div>
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4, lineHeight: 1.5 }}>
              默认用当前地址。前后端分开部署时改成服务端的地址。
              <br />
              留空 = 只用本地，不做同步。
            </div>
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://your-mini-pc.tailnet.ts.net"
              style={{
                width: '100%',
                height: 38,
                padding: '0 10px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg)',
                color: 'var(--text)',
                fontSize: 13,
                outline: 'none',
              }}
            />
          </label>

          <label style={{ display: 'block', marginBottom: 16 }}>
            <div style={{ fontSize: 13, marginBottom: 4 }}>访问令牌（可选）</div>
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4, lineHeight: 1.5 }}>
              服务端设置了 SYNC_TOKEN 才需要填。仅靠 tailnet 保护时可留空。
            </div>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="与服务端 SYNC_TOKEN 一致"
              style={{
                width: '100%',
                height: 38,
                padding: '0 10px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg)',
                color: 'var(--text)',
                fontSize: 13,
                outline: 'none',
              }}
            />
          </label>

          {/* 状态 */}
          <div className="chapters" style={{ marginBottom: 16 }}>
            <div className="chapter-row" style={{ fontSize: 13 }}>
              <span className="chapter-row__name">连接状态</span>
              <span
                style={{
                  fontSize: 12,
                  color: s.online ? 'var(--accent)' : 'var(--text-faint)',
                }}
              >
                {s.online ? '已连接' : s.endpoint ? '连不上' : '未配置'}
              </span>
            </div>
            <div className="chapter-row" style={{ fontSize: 13 }}>
              <span className="chapter-row__name">本机标识</span>
              <code style={{ fontSize: 11, color: 'var(--text-faint)' }}>{s.deviceId}</code>
            </div>
            <div className="chapter-row" style={{ fontSize: 13 }}>
              <span className="chapter-row__name">上次同步</span>
              <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                {s.lastSyncAt ? relativeTime(s.lastSyncAt) : '从未'}
                {s.lastResult > 0 && ` · 同步 ${s.lastResult} 项`}
              </span>
            </div>
            {s.error && (
              <div className="chapter-row" style={{ fontSize: 13 }}>
                <span className="chapter-row__name" style={{ color: 'var(--danger)' }}>
                  错误
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--text-faint)',
                    maxWidth: 180,
                    textAlign: 'right',
                    wordBreak: 'break-all',
                  }}
                >
                  {s.error}
                </span>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn--ghost" onClick={() => void syncNow()} disabled={s.syncing}>
              立即同步
            </button>
            <div style={{ flex: 1 }} />
            <button className="btn" onClick={() => void save()}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
