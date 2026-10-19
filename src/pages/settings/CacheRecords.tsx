import { useCallback, useEffect, useState } from 'react';
import { formatAgo, formatBytes } from '@/store/utils';
import { getWarmLog, type WarmLog, type WarmRecord, type WarmStatus } from './cacheApi';

/** 服务端那一轮为什么停下来了。给的是人话，不是状态码 */
const PAUSE_LABEL: Record<string, string> = {
  'cache-full': '盘到上限了',
  'cache-off': '缓存关着',
  'reader-busy': '有人在读，让路',
  budget: '这一轮时间用完，下轮继续',
};

/** 铺完的不标 —— 一列挂满同样的标签等于没标 */
const STATE_BADGE: Record<string, { text: string; cls: string }> = {
  queued: { text: '排队', cls: 'badge-cache' },
  running: { text: '正在铺', cls: 'badge-cache' },
  error: { text: '没铺到', cls: 'badge-warn' },
  dropped: { text: '待腾盘', cls: 'badge-dim' },
};
const PARTIAL = { text: '不全', cls: 'badge-warn' };

/** 先给十条，剩下的要点开才看：这一栏是设置页，不是仓库清单 */
const SHOWN = 10;

function badgeOf(r: WarmRecord) {
  if (r.purgeAt) return STATE_BADGE.dropped;
  if (r.state === 'done' && r.partial) return PARTIAL;
  return STATE_BADGE[r.state];
}

function RecordRow({ r }: { r: WarmRecord }) {
  const badge = badgeOf(r);
  return (
    <div className="settings-row">
      <span className="settings-row__name">
        {r.title}
        {r.idx !== null && r.idx !== undefined ? ` 第 ${r.idx} 章` : ''}
      </span>
      {badge && <span className={`chapter-row__badge ${badge.cls}`}>{badge.text}</span>}
      <span className="settings-row__value">
        {r.got ? `${r.got} 张 · ${formatBytes(r.bytes)} · ` : ''}
        {formatAgo(r.at)}
      </span>
    </div>
  );
}

/**
 * 盘上这些字节是哪一章、什么时候铺的、多大
 *
 * 记的是**追漫的落盘**，不是 cache_index 那份流水 —— 后者按 URL 的 sha256 记账，
 * 单看它认不出是谁的哪一章。阅读时现取的那些图没有归属信息，只能报个差值。
 */
export default function CacheRecords({
  warm,
  tick,
  totalFiles,
}: {
  warm: WarmStatus | null;
  tick: number;
  /** 盘上总张数，用来算"剩下那些是阅读时现取的"。拿不到就不说这句 */
  totalFiles?: number;
}) {
  const [log, setLog] = useState<WarmLog | null>(null);
  const [all, setAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setLog(await getWarmLog(200));
    } catch {
      /* 读不到不该在设置页留一条报错：服务端可能是旧版，没这个端点 */
      setLog(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, tick]);

  if (!warm) return null;

  const paused = warm.lastRound?.paused
    ? PAUSE_LABEL[warm.lastRound.paused] ?? warm.lastRound.paused
    : null;

  const rows = log?.records ?? [];
  const shown = all ? rows : rows.slice(0, SHOWN);

  /*
   * 三档要能加回上面那个总数：在册 + 待腾盘 + 阅读时现取 = 已缓存。
   * 差值是零就不写"其余是阅读时现取的" —— 那句只在真剩下东西时才是实话。
   */
  const others =
    log && typeof totalFiles === 'number'
      ? Math.max(0, totalFiles - log.warm.live.files - log.warm.dropping.files)
      : null;
  const summary = !log
    ? '读不到记录，服务端可能是旧版。'
    : `追漫在册 ${log.warm.live.files} 张 · ${formatBytes(log.warm.live.bytes)}` +
      (log.warm.dropping.files
        ? `，另有 ${log.warm.dropping.files} 张待腾盘（${formatBytes(log.warm.dropping.bytes)}，到期就清）`
        : '') +
      (others ? `，其余 ${others} 张是阅读时现取的，服务端不记出处。` : '。');

  return (
    <>
      <h3 className="settings-h">缓存记录（{log ? `${log.records.length} 条` : '读不到'}）</h3>

      <p className="settings-note">
        {summary}
        {/*
         * 卡住的原因必须写在脸上。这一栏静默退化过同类问题：
         * 用户开着追漫、服务端其实一章都没铺，界面上却一切正常。
         */}
        {(warm.pending || paused) && <br />}
        {(warm.pending || paused) &&
          `${warm.pending ? `${warm.pending} 章在等` : ''}${warm.pending && paused ? ' · ' : ''}${paused ? `这一轮停了：${paused}` : ''}。`}
      </p>

      {rows.length === 0 && log && (
        <div className="settings-rows">
          <div className="settings-row">
            <span className="settings-row__name">还没有追漫铺过的章节 —— 在详情页点亮那颗爱心就有了。</span>
          </div>
        </div>
      )}

      {shown.length > 0 && (
        <div className="settings-rows">
          {shown.map((r) => (
            <RecordRow key={`${r.pluginId}/${r.slug}/${r.chapterId}`} r={r} />
          ))}
        </div>
      )}

      {rows.length > SHOWN && (
        <button className="btn btn--ghost" style={{ marginTop: 8 }} onClick={() => setAll(!all)}>
          {all ? '收起' : `展开全部 ${rows.length} 条`}
        </button>
      )}
    </>
  );
}
