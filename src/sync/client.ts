import { collectLocal, type RemoteSnapshot } from './transfer';
import { applyRemote } from './applyRemote';
import { pruneTombstones } from '@/store/tombstones';
import { emitDataChange } from '@/store/dataEvents';

/**
 * 同步管理器
 *
 * 职责只有三件事：定时触发、发请求、维护状态。
 * 数据搬运在 transfer.ts（本地→服务端）和 applyRemote.ts（服务端→本地）。
 *
 * 设计要点：
 *   - 单飞：同步进行中再次调用复用同一次 Promise，不并发
 *   - 失败不阻塞：服务端不可达时静默降级，本地功能完全不受影响
 *   - 双向：先推后拉，保证服务端至少有本地的新数据
 *   - 事件驱动：页面重新可见、恢复联网时立刻同步（手机切后台后定时器会被冻结）
 */

export interface SyncState {
  /** 服务端可达 */
  online: boolean;
  syncing: boolean;
  lastSyncAt: number | null;
  /** 上次推送被接受的变更数 */
  lastResult: number;
  error: string | null;
  deviceId: string;
  /** 服务端地址，空表示未配置 */
  endpoint: string;
}

export type SyncListener = (s: SyncState) => void;

const DEVICE_KEY = 'syncDeviceId';
const ENDPOINT_KEY = 'syncEndpoint';
const TOKEN_KEY = 'syncToken';
const SYNC_INTERVAL = 5 * 60 * 1000;

/**
 * 设备标识。
 * 持久化到 localStorage —— 同一台设备重启后标识不变，
 * 否则服务端会把它当成新设备。用随机串而不是 UA（同型号手机 UA 会撞）。
 */
function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `dev-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/**
 * 服务端地址。
 *
 * 默认同源 —— 部署时前后端在同一域名下（/api/sync/*），
 * 用户什么都不用填就能同步。这是绝大多数情况。
 * 只有「前后端分开部署」才需要在设置里显式填地址。
 */
function getEndpoint(): string {
  const saved = localStorage.getItem(ENDPOINT_KEY);
  if (saved !== null) return saved; // '' 表示用户显式关掉了同步
  return typeof location === 'undefined' ? '' : location.origin;
}

export function getSyncToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setSyncConfig(opts: { endpoint?: string; token?: string }) {
  if (opts.endpoint !== undefined) localStorage.setItem(ENDPOINT_KEY, opts.endpoint);
  if (opts.token !== undefined) {
    if (opts.token) localStorage.setItem(TOKEN_KEY, opts.token);
    else localStorage.removeItem(TOKEN_KEY);
  }
}

class SyncManager {
  private state: SyncState = {
    online: false,
    syncing: false,
    lastSyncAt: null,
    lastResult: 0,
    error: null,
    deviceId: getDeviceId(),
    endpoint: getEndpoint(),
  };

  private listeners = new Set<SyncListener>();
  private timer: number | undefined;
  private inflight: Promise<void> | null = null;
  private started = false;

  /**
   * 应用新配置。
   *
   * 必须走这个方法而不是直接写 localStorage ——
   * manager 的 state 是在构造时读的，改了存储不会自动更新状态，
   * 结果是「保存了但还在显示未配置」（这个坑踩过）。
   */
  applyConfig(opts: { endpoint?: string; token?: string }) {
    setSyncConfig(opts);
    this.update({
      endpoint: getEndpoint(),
      error: null,
      online: false,
      lastSyncAt: null,
      lastResult: 0,
    });
  }

  getState(): SyncState {
    return { ...this.state };
  }

  subscribe(fn: SyncListener): () => void {
    this.listeners.add(fn);
    fn(this.getState());
    return () => this.listeners.delete(fn);
  }

  private update(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    this.listeners.forEach((fn) => fn(snapshot));
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getSyncToken();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  /** 只探测可达性，不做数据同步 */
  async probe(): Promise<boolean> {
    const ep = this.state.endpoint;
    if (!ep) {
      this.update({ online: false, error: null });
      return false;
    }
    try {
      const r = await fetch(`${ep}/api/health`, { signal: AbortSignal.timeout(5000) });
      const ok = r.ok;
      this.update({ online: ok, error: ok ? null : `健康检查返回 ${r.status}` });
      return ok;
    } catch (e) {
      this.update({ online: false, error: (e as Error).message });
      return false;
    }
  }

  /** 一次完整同步。并发调用会复用同一次 Promise */
  sync(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doSync().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doSync(): Promise<void> {
    const ep = this.state.endpoint;
    if (!ep) {
      this.update({ syncing: false, online: false });
      return;
    }

    this.update({ syncing: true, error: null });
    try {
      // 1. 推本地
      const payload = await collectLocal();
      const pushRes = await fetch(`${ep}/api/sync/push`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ ...payload, deviceId: this.state.deviceId, seq: 0 }),
      });
      if (!pushRes.ok) throw new Error(`推送失败 HTTP ${pushRes.status}`);
      const pushBody = (await pushRes.json()) as { applied?: { total?: number } };

      // 2. 拉远端
      const pullRes = await fetch(
        `${ep}/api/sync/pull?since=0&deviceId=${encodeURIComponent(this.state.deviceId)}`,
        { headers: this.headers() },
      );
      if (!pullRes.ok) throw new Error(`拉取失败 HTTP ${pullRes.status}`);
      const remote = (await pullRes.json()) as RemoteSnapshot;

      // 3. 落库
      await applyRemote(remote);

      /*
       * 删除已经落到服务端了，本地墓碑剩下的作用只是"下次 push 别把它当还存在的数据传回去"。
       * 超过 90 天的那些不可能还有设备没同步到，回收掉，避免墓碑表无限增长。
       */
      await pruneTombstones();

      /*
       * 通知 UI 重读。
       * 不通知的话数据虽然写进去了，但书架、主题这些页面还停在旧状态 ——
       * 「同步成功但界面没变」是最容易让人以为功能坏了的表现。
       */
      emitDataChange();

      this.update({
        online: true,
        syncing: false,
        lastSyncAt: Date.now(),
        lastResult: pushBody.applied?.total ?? 0,
        error: null,
      });
    } catch (e) {
      /*
       * 服务端不可达不是「错误状态」—— 本地功能照常用，只是这次没同步上。
       * 所以只更新 online/error，不清 lastSyncAt（保留「上次成功是什么时候」）。
       */
      this.update({ online: false, syncing: false, error: (e as Error).message });
    }
  }

  /**
   * 启动自动同步
   *
   * 事件驱动为主、定时器兜底：
   * 手机切后台后浏览器会冻结定时器，回到前台时立刻同步比等定时器靠谱。
   */
  start() {
    if (this.started) return;
    this.started = true;

    void this.sync();

    this.timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void this.sync();
    }, SYNC_INTERVAL);

    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.onOnline);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    clearInterval(this.timer);
    this.timer = undefined;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.onOnline);
  }

  private onVisibility = () => {
    if (document.visibilityState === 'visible') void this.sync();
  };

  private onOnline = () => void this.sync();
}

export const sync = new SyncManager();
