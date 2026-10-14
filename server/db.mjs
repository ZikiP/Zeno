import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * 同步数据存储
 *
 * 用 Node 22 内置的 node:sqlite —— 不需要编译原生模块，
 * MiniPC 上 `node server/index.mjs` 就能跑，零 npm 依赖。
 *
 * 数据模型：单用户。每张表带 device_id 列记录「最后写入来自哪台设备」，
 * 只用于调试和「谁的改动」提示，不做冲突解决。
 *
 * 冲突策略（见 README）：
 *   书架     按 slug 取 updated_at 新的一方（集合式，取并集）
 *   进度     取 updated_at 新的一方（标量式，天然收敛）
 *   书签     按 (chapterId,page) 取新的一方
 *   插件/偏好 单份文档，取 updated_at 新的一方
 */

const DB_PATH = resolve(process.env.DB_PATH || './data/zeno.db');

let db;

/** 打开数据库，首次运行建表 */
export function openDb() {
  if (db) return db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);

  // WAL 模式：读写不互相阻塞，MiniPC 上多设备同时同步不会卡
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    -- 已安装的插件。整机一份，任意设备导入后其他设备下次同步能看到
    CREATE TABLE IF NOT EXISTS plugins (
      id         TEXT PRIMARY KEY,
      origin     TEXT NOT NULL DEFAULT 'imported',
      data       TEXT NOT NULL,        -- 完整 Plugin JSON
      updated_at INTEGER NOT NULL,
      device_id  TEXT
    );

    -- 书架。按 (pluginId, slug) 唯一
    CREATE TABLE IF NOT EXISTS shelf (
      plugin_id  TEXT NOT NULL,
      slug       TEXT NOT NULL,
      title      TEXT NOT NULL,
      cover      TEXT NOT NULL DEFAULT '',
      added_at   INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      device_id  TEXT,
      PRIMARY KEY (plugin_id, slug)
    );

    -- 阅读进度
    CREATE TABLE IF NOT EXISTS positions (
      plugin_id  TEXT NOT NULL,
      slug       TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      percent    INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      device_id  TEXT,
      PRIMARY KEY (plugin_id, slug, chapter_id)
    );

    -- 书架条目的「读到哪一章」
    CREATE TABLE IF NOT EXISTS last_chapter (
      plugin_id   TEXT NOT NULL,
      slug        TEXT NOT NULL,
      chapter_id  TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      device_id   TEXT,
      PRIMARY KEY (plugin_id, slug)
    );

    -- 书签与笔记
    CREATE TABLE IF NOT EXISTS bookmarks (
      key         TEXT PRIMARY KEY,   -- \`\${pluginId}/\${slug}/\${chapterId}/\${page}\`
      plugin_id   TEXT NOT NULL,
      slug        TEXT NOT NULL,
      chapter_id  TEXT NOT NULL,
      page        INTEGER NOT NULL,
      percent     INTEGER NOT NULL DEFAULT 0,
      thumb       TEXT,
      note        TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      device_id   TEXT
    );

    -- 设置：主题、阅读偏好、活动插件
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,        -- JSON
      updated_at INTEGER NOT NULL,
      device_id  TEXT
    );

    -- 单调递增的变更序号。客户端用它做「拉增量」而不是全量对账
    CREATE TABLE IF NOT EXISTS change_log (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      entity     TEXT NOT NULL,        -- shelf / position / bookmark / plugin / setting
      updated_at INTEGER NOT NULL,
      device_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_change_log_seq ON change_log(seq);

    -- 客户端上报的同步游标，用于「我上次同步到哪」
    CREATE TABLE IF NOT EXISTS client_state (
      device_id      TEXT PRIMARY KEY,
      last_pulled_seq INTEGER NOT NULL DEFAULT 0,
      last_push_at   INTEGER NOT NULL DEFAULT 0,
      user_agent     TEXT
    );
  `);

  return db;
}

export function dbPath() {
  return DB_PATH;
}

/* ── 变更日志 ─────────────────────────────────────── */

/** 记一次变更，返回新的 seq。客户端据此增量拉取 */
export function logChange(entity, deviceId) {
  const d = openDb();
  d.prepare('INSERT INTO change_log (entity, updated_at, device_id) VALUES (?, ?, ?)').run(
    entity,
    Date.now(),
    deviceId ?? null,
  );
  return d.prepare('SELECT last_insert_rowid() AS seq').get().seq;
}

/** 当前最大 seq。客户端首次拉取用这个对账 */
export function currentSeq() {
  return openDb().prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log').get().seq;
}

/**
 * 拉取变更
 *
 * sinceSeq 之后的所有变更。没有增量索引时退化为全量。
 */
export function pull(sinceSeq = 0) {
  const d = openDb();
  const seq = currentSeq();

  return {
    seq,
    // 各表全量返回。数据量小（几十 KB），全量比增量更不容易出错
    plugins: d.prepare('SELECT * FROM plugins ORDER BY updated_at').all(),
    shelf: d.prepare('SELECT * FROM shelf ORDER BY added_at').all(),
    positions: d.prepare('SELECT * FROM positions ORDER BY updated_at').all(),
    lastChapter: d.prepare('SELECT * FROM last_chapter').all(),
    bookmarks: d.prepare('SELECT * FROM bookmarks ORDER BY created_at DESC').all(),
    settings: d.prepare('SELECT * FROM settings').all(),
    sinceSeq,
  };
}

/* ── 客户端上报状态 ───────────────────────────────── */

export function saveClientState(deviceId, seq, ua) {
  openDb()
    .prepare(
      `INSERT INTO client_state (device_id, last_pulled_seq, last_push_at, user_agent)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         last_pulled_seq = excluded.last_pulled_seq,
         last_push_at    = excluded.last_push_at,
         user_agent      = excluded.user_agent`,
    )
    .run(deviceId, seq, Date.now(), ua ?? null);
}

export function listClients() {
  return openDb().prepare('SELECT * FROM client_state ORDER BY last_push_at DESC').all();
}

export function stats() {
  const d = openDb();
  const one = (sql) => d.prepare(sql).get().n;
  return {
    plugins: one('SELECT COUNT(*) n FROM plugins'),
    shelf: one('SELECT COUNT(*) n FROM shelf'),
    positions: one('SELECT COUNT(*) n FROM positions'),
    bookmarks: one('SELECT COUNT(*) n FROM bookmarks'),
    changes: one('SELECT COUNT(*) n FROM change_log'),
    seq: currentSeq(),
    dbPath: DB_PATH,
  };
}
