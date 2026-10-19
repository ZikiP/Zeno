/**
 * 追漫预热的台账：配置、地址归一化、warm 表的所有读写
 *
 * 单独一个文件是因为 warm.mjs 管的是"什么时候取、取多快"，这里只管"账上有什么"。
 * 两边各自改的时候，不容易把对方的规矩碰坏。
 */
import { openDb } from './db.mjs';
import { localConfig } from './cache-config.mjs';

const KEEP_KEY = 'warm_keep_chapters';
const DEFAULT_KEEP = Number(process.env.ZENO_WARM_KEEP || 5);

/**
 * 本机对外怎么说自己（回环自请求要用）与令牌。
 *
 * 存在这一层的原因是 upstreamOf：客户端递来的地址是 /api/proxy?url=… 这种
 * **同源相对**形态，要还原成上游地址得先知道"同源"是哪个 origin。
 * 真值是 index.mjs 起服务时传进来的；默认值照 env 来，为的是忘了接线也还能跑 ——
 * 端口被改过还按默认自请求，表现是预热一直"成功"而一个字节没落盘。
 */
let self = {
  origin: `http://127.0.0.1:${Number(process.env.PORT || 8788)}`,
  token: process.env.SYNC_TOKEN || '',
};

export function setSelf(next) {
  self = { ...self, ...next };
}
export const selfOrigin = () => self.origin;
export const selfToken = () => self.token;

/** 没配过就听 env 的；设置页改过一次之后就听设置页的 */
export function keepChapters() {
  const saved = localConfig.get(KEEP_KEY);
  if (saved !== null) {
    const n = Number(saved);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  return DEFAULT_KEEP;
}

export function saveKeepChapters(input) {
  const n = Math.round(Number(input));
  if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('保留章数得是个非负的数'), { status: 400 });
  localConfig.set(KEEP_KEY, String(n));
  return keepChapters();
}

/**
 * 把 /api/proxy?url=… 这种形态解回上游地址。
 *
 * 客户端手里的图片地址本来就是代理形态（engine.ts 的 proxied() 包过一层），
 * 而盘上的键是**上游地址**的 sha256（见 cache-store 的 keyOf）。存代理形态的话，
 * 淘汰时算出来的键跟账本对不上，那张就永远删不掉。
 */
function upstreamOf(img) {
  let raw = String(img ?? '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) {
    // 相对形态（/api/proxy?url=…）在服务端没有"同源"可解析，按自己对外说的那个 origin 补
    try {
      raw = new URL(raw, `${self.origin}/`).toString();
    } catch {
      return null;
    }
  }
  try {
    const u = new URL(raw);
    const inner = u.searchParams.get('url');
    if (inner && /^https?:\/\//i.test(inner)) return new URL(inner).toString();
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * 把一本书的台账对齐到「客户端递交的这一份」。
 *
 * 幂等，方向只有一个：这份表就是这本书该留的集合。没在表里的行标成 dropped，
 * 由 warm-gc 过了宽限期删字节 —— 所以"关掉追漫"就是递交一份空表，不用另一个端点。
 *
 * 地址没变、又已经在铺或铺好的行不重排：只续一下 updated_at。
 * 否则每打开一次书就把整本重下一遍。
 */
export function alignBook(pluginId, slug, chapters) {
  const d = openDb();
  const now = Date.now();
  const kept = [];
  let queued = 0;

  d.exec('BEGIN');
  try {
    for (const c of chapters) {
      const cid = String(c?.id ?? '');
      if (!cid) continue;
      const images = [...new Set((Array.isArray(c.images) ? c.images : []).map(upstreamOf).filter(Boolean))];
      if (!images.length) continue;
      kept.push(cid);
      const asJson = JSON.stringify(images);
      const prev = d
        .prepare('SELECT state, images FROM warm WHERE plugin_id = ? AND slug = ? AND chapter_id = ?')
        .get(pluginId, slug, cid);
      if (prev && prev.images === asJson && (prev.state === 'queued' || prev.state === 'running' || prev.state === 'done')) {
        d.prepare('UPDATE warm SET updated_at = ? WHERE plugin_id = ? AND slug = ? AND chapter_id = ?').run(
          now,
          pluginId,
          slug,
          cid,
        );
        continue;
      }
      d.prepare(
        `INSERT INTO warm (plugin_id, slug, chapter_id, idx, images, got, bytes, state, error, warmed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, 'queued', NULL, NULL, ?)
         ON CONFLICT(plugin_id, slug, chapter_id) DO UPDATE SET
           idx = excluded.idx, images = excluded.images, got = 0, bytes = 0,
           state = 'queued', error = NULL, warmed_at = NULL, updated_at = excluded.updated_at`,
      ).run(pluginId, slug, cid, Number.isFinite(c.index) ? Math.round(c.index) : null, asJson, now);
      queued++;
    }
    if (kept.length) {
      const marks = kept.map(() => '?').join(',');
      d.prepare(
        `UPDATE warm SET state = 'dropped', updated_at = ?
         WHERE plugin_id = ? AND slug = ? AND state <> 'dropped' AND chapter_id NOT IN (${marks})`,
      ).run(now, pluginId, slug, ...kept);
    } else {
      // 空表 = 这本书不追了。整本标掉，宽限期一过就腾盘
      d.prepare('UPDATE warm SET state = ?, updated_at = ? WHERE plugin_id = ? AND slug = ?').run(
        'dropped',
        now,
        pluginId,
        slug,
      );
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return { queued, kept: kept.length };
}

/** 下一个该铺的：按递交顺序（客户端就是按"离脚下最近"排的） */
export function nextQueued() {
  return openDb().prepare("SELECT * FROM warm WHERE state = 'queued' ORDER BY updated_at ASC LIMIT 1").get();
}

/** 领走一行。领了就得铺完，不然它停在 running 等下次重启来捡 */
export function claimRow(row) {
  openDb()
    .prepare("UPDATE warm SET state = 'running', updated_at = ? WHERE plugin_id = ? AND slug = ? AND chapter_id = ?")
    .run(Date.now(), row.plugin_id, row.slug, row.chapter_id);
}

/**
 * 交账。got 为 0 才是 error（一张都没铺到），铺到一半算 done ——
 * 缺的那几张用户翻到时照旧现取一次，比整章判死强。
 */
export function settleRow(row, { got, bytes, failed, error }) {
  const state = got === 0 ? 'error' : 'done';
  openDb()
    .prepare(
      `UPDATE warm SET state = ?, got = ?, bytes = bytes + ?, error = ?,
         warmed_at = CASE WHEN ? = 'done' THEN COALESCE(warmed_at, ?) ELSE warmed_at END,
         updated_at = ?
       WHERE plugin_id = ? AND slug = ? AND chapter_id = ?`,
    )
    .run(state, got, bytes, error, state, Date.now(), Date.now(), row.plugin_id, row.slug, row.chapter_id);
  return state;
}

/** 这一行自己出错了（地址表读不出 JSON 之类）：留下原因，别拖垮整轮 */
export function failRow(row, message) {
  openDb()
    .prepare("UPDATE warm SET state = 'error', error = ?, updated_at = ? WHERE plugin_id = ? AND slug = ? AND chapter_id = ?")
    .run(String(message ?? '').slice(0, 160), Date.now(), row.plugin_id, row.slug, row.chapter_id);
}

/** 各状态各有几章 */
export function ledger() {
  return Object.fromEntries(
    openDb()
      .prepare('SELECT state, COUNT(*) AS n FROM warm GROUP BY state')
      .all()
      .map((r) => [r.state, r.n]),
  );
}

/** 上次崩在半路的行重新排队。返回重排了几行 */
export function resumeRunning() {
  return openDb().prepare("UPDATE warm SET state = 'queued' WHERE state = 'running'").run().changes;
}
