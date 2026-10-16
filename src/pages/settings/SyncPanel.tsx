import { useCallback, useEffect, useState } from 'react';
import { Field, FieldGroup } from '@/components/FormKit';
import { formatAgo } from '@/store/utils';
import type { PeerInfo } from '@/sync/device';
import { sync, type SyncState } from '@/sync/client';

/**
 * 多端同步
 *
 * 地址、令牌、这台的显示名，以及服务端记下的设备列表。
 * 顶栏那颗状态泡在 SyncPill.tsx —— 那是同一件事的两面，分开两个文件，
 * 合起来早就过了组件的 250 行上限。点泡上的状态会落到这一栏。
 */
export default function SyncPanel() {
  const [s, setS] = useState<SyncState>(sync.getState());
  const [endpoint, setEndpoint] = useState(s.endpoint);
  const [token, setToken] = useState('');
  const [label, setLabel] = useState(s.deviceLabel);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => sync.subscribe(setS), []);

  const loadPeers = useCallback(async () => setPeers(await sync.peers()), []);
  // 打开这栏就捞一次设备列表：角色是服务端判的，本地无从得知
  useEffect(() => {
    void loadPeers();
  }, [loadPeers]);

  /** 先把配置落下去（否则改动不生效），再探测、推送 */
  const syncNow = async () => {
    setNote(null);
    sync.applyConfig({ endpoint: endpoint.trim(), token: token.trim() || undefined });
    sync.setLabel(label);
    await sync.probe();
    await sync.sync();
    await loadPeers();
    setNote(sync.getState().online ? '已保存并同步' : '已保存 —— 但连不上那个地址');
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
    <>
      <p className="settings-note">
        填好服务端地址后，书架、阅读进度、书签笔记、插件与偏好会在手机、平板、电脑之间自动同步。
        <br />
        <em>离线时照常本地可用，联网后自动补同步。留空 = 只用本机，不做同步。</em>
      </p>

      <FieldGroup>
        <Field
          label="这台设备的名字"
          hint="出现在设备列表里的是它，不是那串 dev-xxx 标识。"
          value={label}
          onChange={setLabel}
          placeholder="比如：手机 / 平板 / 客厅那台"
        />
        <Field
          label="服务端地址"
          hint="默认用当前地址。前后端分开部署时改成服务端的地址。"
          value={endpoint}
          onChange={setEndpoint}
          placeholder="https://your-mini-pc.tailnet.ts.net"
        />
        <Field
          label="访问令牌（可选）"
          hint="服务端设了 SYNC_TOKEN 才需要填。仅靠 tailnet 保护时留空。"
          value={token}
          onChange={setToken}
          type="password"
          placeholder="与服务端 SYNC_TOKEN 一致"
        />
      </FieldGroup>

      <h3 className="settings-h">状态</h3>
      <div className="settings-rows">
        <div className="settings-row">
          <span className="settings-row__name">连接状态</span>
          <span
            className={`settings-row__value${s.online ? ' settings-row__value--accent' : ''}`}
          >
            {s.online ? '已连接' : s.endpoint ? '连不上' : '未配置'}
          </span>
        </div>
        {/* 角色由服务端判（它才知道自己是谁），所以刚从没同步过时是"未知" */}
        <div className="settings-row">
          <span className="settings-row__name">这台设备</span>
          <span className="settings-row__value">{me ? (roleLabel(me) ?? '角色未知') : '还没同步过'}</span>
        </div>
        <div className="settings-row">
          <span className="settings-row__name">本机标识</span>
          <code className="settings-row__code">{s.deviceId}</code>
        </div>
        <div className="settings-row">
          <span className="settings-row__name">上次同步</span>
          <span className="settings-row__value">
            {s.lastSyncAt ? formatAgo(s.lastSyncAt) : '从未'}
            {s.lastResult > 0 && ` · ${s.lastResult} 项`}
          </span>
        </div>
        {s.error && (
          <div className="settings-row">
            <span className="settings-row__name" style={{ color: 'var(--danger)' }}>
              错误
            </span>
            <span className="settings-row__value" style={{ wordBreak: 'break-all' }}>
              {s.error}
            </span>
          </div>
        )}
      </div>

      {recent.length > 0 && (
        <>
          <h3 className="settings-h">同步过的设备（最近 30 天，{recent.length}）</h3>
          <div className="settings-rows">
            {recent.map((p) => {
              const self = p.device_id === s.deviceId;
              const role = roleLabel(p);
              return (
                <div key={p.device_id} className="settings-row">
                  <span className="settings-row__name">
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
                  <span className="settings-row__value">{formatAgo(p.last_push_at)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {note && (
        <div className="notice-ok" style={{ marginTop: 12 }}>
          {note}
        </div>
      )}

      <div className="settings-actions">
        <button className="btn btn--ghost" onClick={() => void syncNow()} disabled={s.syncing}>
          {s.syncing ? '同步中…' : '保存并立即同步'}
        </button>
      </div>
    </>
  );
}
