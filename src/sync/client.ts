import { collectLocal, type RemoteSnapshot } from './transfer';
import { applyRemote } from './applyRemote';
import { observeServerTime } from './clock';
import { pruneTombstones } from '@/store/tombstones';
import { emitDataChange } from '@/store/dataEvents';
import {
  getDeviceId,
  getDeviceLabel,
  getEndpoint,
  getSyncToken,
  setDeviceLabel,
  setSyncConfig,
  type PeerInfo,
} from './device';

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
  /** 这台设备的显示名（可改）。只有它出现在设备列表里，deviceId 是内部的键 */
  deviceLabel: string;
  /** 服务端地址，空表示未配置 */
  endpoint: string;
}

export type SyncListener = (s: SyncState) => void;

const SYNC_INTERVAL = 5 * 60 * 1000;
/**
 * 单次同步请求的上限。
 *
 * 没有这个超时的话，一个"连得上但不回包"的服务端会让整轮同步永远挂着 ——
 * 而挂着的这一轮还挡着后面每 5 分钟一次的触发（inflight 复用同一个 Promise）。
 */
const SYNC_FETCH_MS = 15_000;
/**
 * 上次成功拉取的 seq。只存在这台设备上：它描述的是"我本地已经追到哪"，
 * 不是要同步的数据。没有它就只能每次 since=0 搬整库。
 */
const LAST_SEQ_KEY = 'syncLastSeq';

class SyncManager {
  private state: SyncState = {
    online: false,
    syncing: false,
    lastSyncAt: null,
    lastResult: 0,
    error: null,
    deviceId: getDeviceId(),
    deviceLabel: getDeviceLabel(),
    endpoint: getEndpoint(),
  };

  private listeners = new Set<SyncListener>();
  private timer: number | undefined;
  private inflight: Promise<void> | null = null;
  private started = false;
  /**
   * 首轮同步是否已经出结果（成功、失败都算）。
   *
   * 有的页面要区分「本地确实没有插件」和「同步还没落库」：
   * 冷启动直接打开 /explore 时，第一轮同步往往还在路上，
   * 这时判定"没有插件"并把用户弹到设置页，等于凭空报一个假空状态 ——
   * 而且弹过去之后插件才到，人却留在设置页上。
   */
  private settled = false;
  private waiters = new Set<() => void>();

  /** 首轮同步出结果时 resolve。已经出过就立即 resolve */
  whenSettled(): Promise<void> {
    if (this.settled) return Promise.resolve();
    return new Promise((res) => this.waiters.add(res));
  }

  private settle() {
    if (this.settled) return;
    this.settled = true;
    const w = [...this.waiters];
    this.waiters.clear();
    w.forEach((fn) => fn());
  }

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
    /* 头的值只允许 latin1，中文名要先编码，服务端再解回来 */
    h['X-Device-Label'] = encodeURIComponent(this.state.deviceLabel);
    // 服务端用它判断这台是不是它自己那台机器（见 sync-api 的 clientRole）
    h['X-Client-Host'] = typeof location === 'undefined' ? '' : location.hostname;
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

  /** 改这台设备的显示名。改名不单独同步 —— 下一次 push/pull 就带过去了 */
  setLabel(value: string) {
    this.update({ deviceLabel: setDeviceLabel(value) });
  }

  /**
   * 服务端记的设备列表。
   *
   * 「这台是不是跑服务的那台机器」只有服务端判得出来（它知道自己的主机名，
   * 也看得见连接来自哪儿），所以本机角色也是从这里读回来的，不在本地猜。
   * 拉不到就当没有 —— 离线时同步面板照常能用。
   */
  async peers(): Promise<PeerInfo[]> {
    const ep = this.state.endpoint;
    if (!ep) return [];
    try {
      const r = await fetch(`${ep}/api/sync/clients`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return [];
      const body = (await r.json()) as { clients?: PeerInfo[] };
      return body.clients ?? [];
    } catch {
      return [];
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
      this.settle();
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
        signal: AbortSignal.timeout(SYNC_FETCH_MS),
      });
      if (!pushRes.ok) throw new Error(`推送失败 HTTP ${pushRes.status}`);
      const pushBody = (await pushRes.json()) as { applied?: { total?: number }; serverTime?: number };
      /*
       * 先对时再落库：这一轮拉回来的行要拿去和本地比 updatedAt，
       * 而本地那些戳是 collectLocal 之前盖的 —— 越早知道正确偏移，
       * 这一轮里"本地新还是远端新"判得越准。
       */
      observeServerTime(pushBody.serverTime ?? 0);

      // 2. 拉远端。带上次 seq：服务端确认没变化时只回一个空快照
      /*
       * 本地主数据全空但还留着 lastSeq（IndexedDB 被浏览器回收、用户清了站点数据
       * 的一部分）时必须回 since=0，否则会以为自己已经追平，永远拉不回来。
       */
      const local = payload as {
        plugins?: unknown[];
        shelf?: unknown[];
        bookmarks?: unknown[];
        bookPrefs?: unknown[];
      };
      const localEmpty =
        !local.plugins?.length &&
        !local.shelf?.length &&
        !local.bookmarks?.length &&
        !local.bookPrefs?.length;
      /*
       * 这一轮真的推上去了东西时也拉全量：push 可能被服务端按 LWW 合并过，
       * 只拉"增量"容易把自己刚推的旧值和别处的新值之间的关系看漏。
       */
      const applied = pushBody.applied?.total ?? 0;
      const since = localEmpty || applied > 0
        ? 0
        : Number(localStorage.getItem(LAST_SEQ_KEY) ?? 0) || 0;
      const pullRes = await fetch(
        `${ep}/api/sync/pull?since=${encodeURIComponent(since)}&deviceId=${encodeURIComponent(this.state.deviceId)}`,
        { headers: this.headers(), signal: AbortSignal.timeout(SYNC_FETCH_MS) },
      );
      if (!pullRes.ok) throw new Error(`拉取失败 HTTP ${pullRes.status}`);
      const remote = (await pullRes.json()) as RemoteSnapshot;
      observeServerTime(remote.serverTime ?? 0);

      // 3. 落库。没变化就跳过整轮事务和 UI 重读
      if (!remote.unchanged) {
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
      }
      localStorage.setItem(LAST_SEQ_KEY, String(remote.seq));

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
    } finally {
      /*
       * 成功、失败、超时都要放行等待首轮结果的页面 ——
       * 服务端不可达是常态（手机在 tailnet 外面），不能让人一直卡在「加载中」。
       */
      this.settle();
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
