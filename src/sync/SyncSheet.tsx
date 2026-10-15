import { useEffect, useState } from 'react';
import { Divider, Field } from '@/components/FormKit';
import { formatAgo } from '@/store/utils';
import type { PeerInfo } from '@/sync/device';
import { sync, type SyncState } from '@/sync/client';

/**
 * 同步配置弹层：服务端地址与令牌、这台的显示名、服务端记下的设备列表。
 * 状态条在 SyncBar.tsx，那份"我同步了没"的读数不需要跟着打开面板。
 */
export default function SyncSheet({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<SyncState>(sync.getState());
  const [endpoint, setEndpoint] = useState(s.endpoint);
  const [token, setToken] = useState('');
  const [label, setLabel] = useState(s.deviceLabel);
  const [peers, setPeers] = useState<PeerInfo[]>([]);

  useEffect(() => sync.subscribe(setS), []);

  const loadPeers = async () => setPeers(await sync.peers());
  // 打开面板就捞一次设备列表：角色是服务端判的，本地无从得知
  useEffect(() => {
    void loadPeers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 立即同步：先保存配置（否则改动不生效），再探测、推送 */
  const syncNow = async () => {
    sync.applyConfig({ endpoint: endpoint.trim(), token: token.trim() || undefined });
    sync.setLabel(label);
    await sync.probe();
    await sync.sync();
    await loadPeers();
  };

  const save = async () => {
    await syncNow();
    onClose();
  };

  /** 服务端判出来的角色。它没上报过时为 null，这时候宁可什么都不标 */
  const roleLabel = (p: PeerInfo) =>
    p.role === 'server' ? '服务端本机' : p.role === 'client' ? '客户端' : null;
  const me = peers.find((p) => p.device_id === s.deviceId);
  /*
   * 只列最近还在同步的设备。
   * client_state 一行代表一个出现过的 deviceId，而它永远不会自己消失 ——
   * 开发库里就攒了二十来行，里头还有 pull-plugins、check 这种脚本留下的。
   * 按"上次推送"筛一下，列表才还是那几台真在用的机器。
   */
  const recent = peers.filter((p) => Date.now() - p.last_push_at < 30 * 86_400_000);

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

          <Field
            label="这台设备的名字"
            hint="出现在设备列表里的是它，不是那串 dev-xxx 标识。默认按浏览器猜，可以随便改。"
            value={label}
            onChange={setLabel}
            placeholder="比如：手机 / 平板 / 客厅那台"
          />

          <label style={{ display: 'block', marginTop: 12, marginBottom: 12 }}>
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
            {/* 角色由服务端判（它才知道自己是谁），所以刚从没同步过时是"未知" */}
            <div className="chapter-row" style={{ fontSize: 13 }}>
              <span className="chapter-row__name">这台设备</span>
              <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                {me ? (roleLabel(me) ?? '角色未知') : '还没同步过'}
              </span>
            </div>
            <div className="chapter-row" style={{ fontSize: 13 }}>
              <span className="chapter-row__name">本机标识</span>
              <code style={{ fontSize: 11, color: 'var(--text-faint)' }}>{s.deviceId}</code>
            </div>
            <div className="chapter-row" style={{ fontSize: 13 }}>
              <span className="chapter-row__name">上次同步</span>
              <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                {s.lastSyncAt ? formatAgo(s.lastSyncAt) : '从未'}
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

          {recent.length > 0 && (
            <>
              <Divider text={`同步过的设备（最近 30 天，${recent.length}）`} />
              <div className="chapters" style={{ margin: '8px 0 16px' }}>
                {recent.map((p) => {
                  const self = p.device_id === s.deviceId;
                  const role = roleLabel(p);
                  return (
                    <div key={p.device_id} className="chapter-row" style={{ fontSize: 13 }}>
                      <span className="chapter-row__name">
                        {p.label || p.device_id}
                        {self && ' （本机）'}
                      </span>
                      {/* 服务端那台机器单独标出来：它同时也是别人的服务端 */}
                      {role && (
                        <span
                          className={`chapter-row__badge ${role === '服务端本机' ? 'badge-done' : 'badge-cache'}`}
                        >
                          {role}
                        </span>
                      )}
                      <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                        {formatAgo(p.last_push_at)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

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
