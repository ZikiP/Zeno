/**
 * 追漫预热的台账：配置、地址归一化、warm 表的所有读写
 *
 * 单独一个文件是因为 warm.mjs 管的是"什么时候取、取多快"，这里只管"账上有什么"。
 * 两边各自改的时候，不容易把对方的规矩碰坏。
 */
import { openDb } from './db.mjs';
import { localConfig } from './cache-config.mjs';

const KEEP_KEY = 'warm_keep_chapters';
const DEFAULT_KEEP = Number(process.env.ZENO_WARM_KEEP || 50);

/**
 * 读到 95% 以上算读完。跟 src/store/shelf.ts 的 READ_AT 对齐。
 *
 * 这是**故意的第二份**，跟 updates.mjs 抄 decodeEntities、warm-resolve 抄 getChapter
 * 同一条路：服务端不该为了一个常数去引浏览器包。两边对不上的后果是刚读完的章
 * 被当成未读一直占盘，不会读坏任何东西。
 */
export const READ_AT = 95;

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

/** 下一个该铺的：按进台账的先后排（补齐台账时就是"离脚下最近"的先排） */
export function nextQueued() {
  return openDb().prepare("SELECT * FROM warm WHERE state = 'queued' ORDER BY updated_at ASC LIMIT 1").get();
}

/** 这本书的台账里，处于这几个状态之一的章有哪些 */
export function warmIds(pluginId, slug, states = ['queued', 'running', 'done']) {
  const marks = states.map(() => '?').join(',');
  return new Set(
    openDb()
      .prepare(`SELECT chapter_id FROM warm WHERE plugin_id = ? AND slug = ? AND state IN (${marks})`)
      .all(pluginId, slug, ...states)
      .map((r) => r.chapter_id),
  );
}

/**
 * 补一章进台账（服务端自己追漫时走这条，不是客户端递交）。
 *
 * 地址表变了就重新排队，没变就只续时间 —— 跟 alignBook 同一条规矩，
 * 否则每 15 分钟一轮就把整本重下一遍。
 */
export function upsertQueued(pluginId, slug, chapterId, index, images) {
  const d = openDb();
  const now = Date.now();
  const asJson = JSON.stringify(images);
  const prev = d
    .prepare('SELECT state, images FROM warm WHERE plugin_id = ? AND slug = ? AND chapter_id = ?')
    .get(pluginId, slug, chapterId);
  if (prev && prev.images === asJson && prev.state !== 'error' && prev.state !== 'dropped') {
    d.prepare('UPDATE warm SET updated_at = ? WHERE plugin_id = ? AND slug = ? AND chapter_id = ?').run(
      now,
      pluginId,
      slug,
      chapterId,
    );
    return 'kept';
  }
  d.prepare(
    `INSERT INTO warm (plugin_id, slug, chapter_id, idx, images, got, bytes, state, error, warmed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 'queued', NULL, NULL, ?)
     ON CONFLICT(plugin_id, slug, chapter_id) DO UPDATE SET
       idx = excluded.idx, images = excluded.images, got = 0, bytes = 0,
       state = 'queued', error = NULL, warmed_at = NULL, updated_at = excluded.updated_at`,
  ).run(pluginId, slug, chapterId, Number.isFinite(index) ? Math.round(index) : null, asJson, now);
  return 'queued';
}

/** 解不出地址表的那些章也要留一行，否则每一轮都重新去解同一章，白敲站点 */
export function markUnresolved(pluginId, slug, chapterId, index, message) {
  openDb()
    .prepare(
      `INSERT INTO warm (plugin_id, slug, chapter_id, idx, images, got, bytes, state, error, updated_at)
       VALUES (?, ?, ?, ?, '[]', 0, 0, 'error', ?, ?)
       ON CONFLICT(plugin_id, slug, chapter_id) DO UPDATE SET
         state = 'error', error = excluded.error, updated_at = excluded.updated_at`,
    )
    .run(pluginId, slug, chapterId, Number.isFinite(index) ? Math.round(index) : null, String(message ?? '').slice(0, 160), Date.now());
}

/**
 * 只留一句备注，不动状态也不动地址表。
 *
 * 用在"铺是铺了、但不全"那种章身上（比如站点没写页码标记，服务端只认第 1 页）。
 * 这种章不能走 markUnresolved —— 那会把刚排好的行连同地址表一起擦成 error，
 * 于是已经下下来的图白下、界面还多一个假报错。
 */
export function noteRow(pluginId, slug, chapterId, message) {
  openDb()
    .prepare('UPDATE warm SET error = ? WHERE plugin_id = ? AND slug = ? AND chapter_id = ?')
    .run(String(message ?? '').slice(0, 160), pluginId, slug, chapterId);
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

/**
 * 一本书的台账，给详情页给章节挂"已缓存"标记用。
 *
 * `partial` 是从 error 那句"只解出部分内页"来的：这种章铺了但不全，
 * 界面上不该挂"已缓存"—— 标错一次，用户就会在真没缓存的那一章上信错它。
 */
export function bookLedger(pluginId, slug) {
  return openDb()
    .prepare(
      'SELECT chapter_id, state, got, idx, purge_at, error FROM warm WHERE plugin_id = ? AND slug = ? ORDER BY idx',
    )
    .all(pluginId, slug)
    .map((r) => ({
      id: r.chapter_id,
      state: r.state,
      got: r.got,
      purgeAt: r.purge_at,
      partial: !!r.error,
      /** 能不能挂"已缓存"：铺完了、且不是只铺了一半 */
      cached: r.state === 'done' && !r.error,
    }));
}

/** 上次崩在半路的行重新排队。返回重排了几行 */
export function resumeRunning() {
  return openDb().prepare("UPDATE warm SET state = 'queued' WHERE state = 'running'").run().changes;
}
