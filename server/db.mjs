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
      -- 用户手动排出来的顺序，小的在前。不叫 order：那是 SQL 关键字，
      -- 裸写在 SELECT/ALTER 里迟早撞语法。
      sort_order INTEGER,
      device_id  TEXT,
      PRIMARY KEY (plugin_id, slug)
    );

    -- 每本书自己的显示偏好（图片适配、方向、单双页、底色、灰度）。
    -- 为什么不塞进 settings 那个大 blob：那样两台设备各改一本不同的书，
    -- 整块 LWW 必然压掉其中一台的其它书。按书一行才谈得拢。
    CREATE TABLE IF NOT EXISTS book_prefs (
      plugin_id  TEXT NOT NULL,
      slug       TEXT NOT NULL,
      data       TEXT NOT NULL,        -- JSON：Partial<BookPrefs>
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

    -- 删除墓碑。
    -- upsert 只能增不能删；没有这张表时，设备删了书架/书签，
    -- 服务端那行还在，它下次 pull 又被插回来 —— 表现为「删不掉」。
    -- 有了墓碑，删除成为可参与 LWW 的状态，并能传播到其他设备。
    CREATE TABLE IF NOT EXISTS deletes (
      kind       TEXT NOT NULL,        -- shelf / bookmark / position / lastChapter / plugin
      id         TEXT NOT NULL,        -- 被删记录的主键
      updated_at INTEGER NOT NULL,
      device_id  TEXT,
      PRIMARY KEY (kind, id)
    );

    -- 客户端上报的同步游标，用于「我上次同步到哪」
    CREATE TABLE IF NOT EXISTS client_state (
      device_id      TEXT PRIMARY KEY,
      last_pulled_seq INTEGER NOT NULL DEFAULT 0,
      last_push_at   INTEGER NOT NULL DEFAULT 0,
      user_agent     TEXT,
      -- 用户给这台起的显示名
      label          TEXT,
      -- 'server' = 就是跑服务的那台机器开的浏览器，'client' = 别的设备
      role           TEXT
    );

    -- 只属于这台机器的配置。
    -- 和 settings 的区别是故意的：settings 参与多端同步，
    -- 而缓存目录这类东西同步过去就是垃圾 —— 手机拿到一个 D:\\ 开头的路径。
    CREATE TABLE IF NOT EXISTS kv_local (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 图片磁盘缓存的账本。文件本身在缓存目录里，这里记谁占了多少、上次碰是什么时候
    CREATE TABLE IF NOT EXISTS cache_index (
      key    TEXT PRIMARY KEY,   -- 上游 URL 的 sha256
      bytes  INTEGER NOT NULL,
      at     INTEGER NOT NULL,   -- 最后访问时间，淘汰按它排
      ctype  TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_cache_index_at ON cache_index(at);

    -- 追更：每本在架书最后一次看到的章节条数。
    -- 记的是**条数**这一种签名，不是章节列表本身 —— 解析在客户端，
    -- 服务端只要知道"比上次多了几条"。徽章上的数字 = 这里的条数 − 客户端手里的条数。
    CREATE TABLE IF NOT EXISTS updates (
      key         TEXT PRIMARY KEY,   -- \`\${pluginId}/\${slug}\`
      plugin_id   TEXT NOT NULL,
      slug        TEXT NOT NULL,
      anchors     INTEGER,            -- 最近一次数到的章节条数；没取到保持旧值
      checked_at  INTEGER NOT NULL,
      changed_at  INTEGER,            -- 条数最后一次发生变化的时刻（没变过就是 NULL）
      error       TEXT
    );

    -- 追漫预热的台账：客户端递交的「这一章的图片地址表」。
    -- 为什么服务端只记地址不自己去找：解析层（src/site/parse.ts）跑在浏览器包里，
    -- 服务端不养第二套解析 —— 这跟 updates 只数条数是同一条原则。
    -- images 存的是**上游地址**（不是 /api/proxy 那条），淘汰时要按它算缓存键。
    CREATE TABLE IF NOT EXISTS warm (
      plugin_id   TEXT NOT NULL,
      slug        TEXT NOT NULL,
      chapter_id  TEXT NOT NULL,
      idx         INTEGER,            -- 客户端给的章节序号，保留策略按它排
      images      TEXT NOT NULL,      -- JSON 数组：上游图片地址
      got         INTEGER NOT NULL DEFAULT 0,
      bytes       INTEGER NOT NULL DEFAULT 0,
      -- queued 待铺 / running 正在铺 / done 铺完 / error 铺过但没铺全
      state       TEXT NOT NULL DEFAULT 'queued',
      error       TEXT,
      warmed_at   INTEGER,            -- 首次铺完的时刻
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, slug, chapter_id)
    );
    CREATE INDEX IF NOT EXISTS idx_warm_state ON warm(state);
  `);

  /*
   * 老库补列。CREATE TABLE IF NOT EXISTS 对已经存在的表什么都不做，
   * 所以已有的 client_state 不会凭空长出 label/role —— 不补的话
   * 部署过一版的机器升级后，设备列表一直是空的，而且没有任何报错。
   */
  const hasColumn = (table, col) =>
    !!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, col);
  const addColumn = (table, col, type) => {
    if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  };

  for (const [col, type] of [
    ['label', 'TEXT'],
    ['role', 'TEXT'],
  ]) {
    addColumn('client_state', col, type);
  }
  addColumn('shelf', 'sort_order', 'INTEGER');
  /*
   * 「读到第几章 / 总共几章」这两个数。章节表缓存（chapterCache）不参与同步，
   * 所以新设备算不出全书进度 —— 书架上那圈进度描边就整个不画了。
   * 把这两个数随 last_chapter 一起存下来，新设备同步完就能直接算。
   */
  addColumn('last_chapter', 'chapter_index', 'INTEGER');
  addColumn('last_chapter', 'chapter_count', 'INTEGER');
  /*
   * 追漫要的章节表：id 数组，**按阅读顺序**存（不是页面 DOM 顺序）。
   *
   * 为什么单独一列而不改 anchors：anchors 是**条数**，书架徽章那个 "+N"
   * 就是「服务端条数 − 客户端手里那份的条数」，两边必须是同一个单位。
   * 换成数组的话徽章的减法当场就废了（而且每本书都挂个假数字，永远消不掉）。
   */
  addColumn('updates', 'chapter_ids', 'TEXT');
  /*
   * 这一行的字节什么时候该腾掉。NULL = 不留到期，按保留窗口判。
   * 读过 3 天、掉出窗口 3 天、整本取消追漫或移出书架 1 天 —— 都写在这儿，
   * 扫描只看一件事：now 到了没有。没到又被重新追回来就把这列清掉。
   */
  addColumn('warm', 'purge_at', 'INTEGER');

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
    bookPrefs: d.prepare('SELECT * FROM book_prefs').all(),
    settings: d.prepare('SELECT * FROM settings').all(),
    deletes: d.prepare('SELECT * FROM deletes ORDER BY updated_at').all(),
    sinceSeq,
  };
}

/* ── 客户端上报状态 ───────────────────────────────── */

/**
 * 记一次这台设备的活动。
 *
 * label / role 用 COALESCE：设备不一定每次都带得上（老版本客户端、
 * 或者只发了一次探测），带了才覆盖，别把已有的名字抹成空的。
 */
export function saveClientState(deviceId, seq, ua, label, role) {
  openDb()
    .prepare(
      `INSERT INTO client_state (device_id, last_pulled_seq, last_push_at, user_agent, label, role)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         last_pulled_seq = excluded.last_pulled_seq,
         last_push_at    = excluded.last_push_at,
         user_agent      = excluded.user_agent,
         label           = COALESCE(excluded.label, client_state.label),
         role            = COALESCE(excluded.role, client_state.role)`,
    )
    .run(deviceId, seq, Date.now(), ua ?? null, label ?? null, role ?? null);
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
