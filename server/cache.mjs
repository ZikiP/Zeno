/**
 * 抓来的图片落一份到本地磁盘
 *
 * 为什么值得做：Service Worker 那份图片缓存（CacheFirst，800 张 / 90 天）是
 * **每台设备各自的**；这份是**所有设备共用的** —— 手机看过的图平板第一次看
 * 不用再回源站，超出 800 张上限的老图、以及根本没装起 SW 的场景
 * （隐私模式、非 HTTPS 的局域网直连）也由它兜住。
 * 漫画图片的 URL 基本是永久的，所以不存在"读到旧内容"这种失效问题。
 *
 * 命中路径不去问上游，因此 CDN 限流或抽风时已经看过的图照样出
 * （实测掐掉源站仍 200）。
 *
 * 只缓存图片。browser 模式渲染出的 HTML 有时效（新话、章节变动），
 * 那份继续走 render.mjs 自己的 TTL，不进这里。
 *
 * 目录可以配：MiniPC 的系统盘小，缓存得能指到大硬盘上。
 * 配置存在 kv_local 而不是 settings —— settings 参与多端同步，
 * 把一台机器的 D:\ 路径同步到手机上纯属垃圾。
 */
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { mkdir, open, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { dbPath, openDb } from './db.mjs';
import { json, readBody } from './respond.mjs';

/** 单张图的上限。漫画页一般 100KB~2MB，超过这个数多半不是图 */
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_MB = Number(process.env.ZENO_CACHE_MAX_MB || 512);
const ENV_DIR = process.env.ZENO_CACHE_DIR || '';

/** 目录写坏了 / 磁盘满了：进程内只吼一次，之后安静地不缓存 */
let warning = null;
let warned = false;

function flag(msg) {
  if (!warned) {
    warned = true;
    console.warn(`[zeno] 图片缓存已停用：${msg}`);
  }
  warning = msg;
}

/* ── 配置 ─────────────────────────────────────────── */

function kvGet(key) {
  const row = openDb().prepare('SELECT value FROM kv_local WHERE key = ?').get(key);
  return row ? row.value : null;
}

function kvSet(key, value) {
  openDb()
    .prepare('INSERT INTO kv_local (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/**
 * 缓存目录。
 *
 * 默认放在数据库旁边（同一块盘，装完就有），除非 env 或设置页另指。
 * 设置页里填了空字符串表示「显式关掉缓存」，和"没填过"不是一回事。
 */
export function cacheDir() {
  const saved = kvGet('cache_dir');
  if (saved !== null) return saved;
  return ENV_DIR || join(dirname(dbPath()), 'cache');
}

export function cacheMaxBytes() {
  const saved = kvGet('cache_max_mb');
  /*
   * 先判 null 再转数字：Number(null) 是 0 而不是 NaN，
   * 少了这一层判断的话「没配过」会被读成「上限 0 = 关掉」，
   * 于是缓存永远不生效，而界面上看着一切正常。
   */
  if (saved !== null) {
    const n = Number(saved);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 1024 * 1024);
  }
  return Math.round(DEFAULT_MAX_MB * 1024 * 1024);
}

/** 关掉了就没必要碰盘：目录为空串，或上限 0 */
export function cacheOn() {
  return !!cacheDir() && cacheMaxBytes() > 0;
}

/**
 * 校验并归一用户给的目录。
 *
 * 只接受绝对路径：相对路径是按进程 cwd 解析的，换个启动方式就指到别处去了，
 * 而部署这件事恰好就是「换个方式启动」。
 * 也拒绝指进应用自己的目录 —— 那里站着代码、dist 和数据库。
 */
export function assertCacheDir(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  if (!isAbsolute(raw)) throw new Error('要给绝对路径，比如 D:\\zeno-cache 或 /mnt/data/zeno-cache');
  const abs = resolve(raw);
  const appRoot = resolve('.');
  const rel = relative(appRoot, abs);
  /*
   * rel 不以 .. 开头且不可能是绝对路径，才说明它还在应用目录里面。
   * 后半个判断不能省：Windows 上跨盘符时 relative('D:\\x','C:\\y')
   * 直接返回 'C:\\y' 这个绝对路径本身，只看开头会把 D 盘应用之外的
   * 每个目录都误判成"指进了应用目录"。
   */
  if (abs === appRoot || (rel && !rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`不能指到应用目录里面（${appRoot}）。换个盘或换个目录。`);
  }
  return abs;
}

/* ── 文件布局 ─────────────────────────────────────── */

const keyOf = (url) => createHash('sha256').update(url).digest('hex');

/** 前两位做分片：一本书几千张图，全堆一个目录里 readdir 会开始变慢 */
const shardOf = (key) => key.slice(0, 2);

const pathOf = (dir, key) => join(dir, shardOf(key), key);

/* ── 账本 ─────────────────────────────────────────── */

function touch(key) {
  openDb()
    .prepare('UPDATE cache_index SET at = ? WHERE key = ?')
    .run(Date.now(), key);
}

function putRow(key, bytes, ctype) {
  openDb()
    .prepare(
      `INSERT INTO cache_index (key, bytes, at, ctype) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET bytes = excluded.bytes, at = excluded.at, ctype = excluded.ctype`,
    )
    .run(key, bytes, Date.now(), ctype);
}

function delRow(key) {
  openDb().prepare('DELETE FROM cache_index WHERE key = ?').run(key);
}

export function totals() {
  const d = openDb();
  const r = d.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM cache_index').get();
  return { files: r.files, bytes: r.bytes };
}

/**
 * 启动时对账。
 *
 * 账本和盘上可能对不上：用户自己清了目录、换了磁盘、或者上次写一半断电。
 * 对不上的那部分一律以盘为准 —— 文件没了就删行，文件没记账就补记，
 * 然后按上限裁一刀。
 */
export async function reconcile() {
  const dir = cacheDir();
  if (!dir) return;
  const d = openDb();
  let present;
  try {
    await stat(dir);
    present = await scan(dir);
  } catch {
    // 目录还没建过，账本里剩下的都是陈旧行
    present = new Map();
  }
  for (const row of d.prepare('SELECT key FROM cache_index').all()) {
    if (!present.has(row.key)) delRow(row.key);
  }
  for (const [key, size] of present) {
    if (d.prepare('SELECT 1 FROM cache_index WHERE key = ?').get(key)) continue;
    /*
     * 盘上有文件但账本没记（升级前存的、或手动拷进来的）：文件头认一下类型。
     * 认不出是图片的就删 —— 这个目录只该躺图片，
     * 留着它既算不进账、也永远命中不了。
     */
    const path = pathOf(dir, key);
    const ctype = await sniffImage(path);
    if (!ctype) {
      await rm(path, { force: true }).catch(() => {});
      continue;
    }
    putRow(key, size, ctype);
  }
  await evict();
}

/** 只读文件头 12 字节，启动时对账几万张图也不至于把盘读完 */
async function sniffImage(path) {
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fh.read(buf, 0, 12, 0);
    return ctypeOf(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

function ctypeOf(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x89 && b.subarray(1, 4).toString() === 'PNG') return 'image/png';
  if (b.length >= 3 && b.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  // ftyp 后面跟的 brand 才是格式，只看 ftyp 会把 mp4 也认进来
  if (b.length >= 12 && b.subarray(4, 8).toString() === 'ftyp') {
    const brand = b.subarray(8, 12).toString();
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return null;
}

async function scan(dir) {
  const out = new Map();
  let shards;
  try {
    shards = readdirSync(dir);
  } catch {
    return out;
  }
  for (const s of shards) {
    if (!/^[0-9a-f]{2}$/.test(s)) continue;
    let names;
    try {
      names = readdirSync(join(dir, s));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/^[0-9a-f]{64}$/.test(n)) continue; // 半截的 .part 之类，直接忽略
      try {
        out.set(n, statSync(join(dir, s, n)).size);
      } catch {
        /* 读不到就当没有 */
      }
    }
  }
  return out;
}

/** 超上限就按最后访问时间从旧往新删 */
export async function evict() {
  const max = cacheMaxBytes();
  const dir = cacheDir();
  if (!dir || !max) return;
  const { bytes } = totals();
  if (bytes <= max) return;
  const d = openDb();
  const rows = d.prepare('SELECT key, bytes FROM cache_index ORDER BY at ASC').all();
  let over = bytes - max;
  for (const r of rows) {
    if (over <= 0) break;
    try {
      await rm(pathOf(dir, r.key), { force: true });
    } catch (e) {
      flag(`删不掉 ${r.key.slice(0, 8)}：${e.message}`);
    }
    delRow(r.key);
    over -= r.bytes;
  }
}

/* ── 读写 ─────────────────────────────────────────── */

export function isImage(ctype) {
  return (ctype ?? '').toLowerCase().startsWith('image/');
}

/**
 * 查一张缓存图。
 *
 * 命中的键只可能是「当初按 image/* 存进去的 URL」，所以这里不用再判类型。
 * 命中就续一次访问时间 —— 淘汰按最后访问排，常用的那批不会被裁掉。
 */
export function lookup(url) {
  if (!cacheOn()) return null;
  const key = keyOf(url);
  const row = openDb().prepare('SELECT bytes, ctype FROM cache_index WHERE key = ?').get(key);
  if (!row) return null;
  const path = pathOf(cacheDir(), key);
  try {
    statSync(path);
  } catch {
    delRow(key); // 文件被人手动删了，账本跟着删
    return null;
  }
  touch(key);
  return { key, path, bytes: row.bytes, ctype: row.ctype };
}

/** 图片给浏览器的时效：URL 基本不变，放到一天，过期了还能先给旧的再后台补 */
export const IMG_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';

/**
 * 把缓存里的图直接回给客户端。
 *
 * X-Zeno-Cache 是给我们自己看的：测试和排查「这张图到底有没有命中」
 * 靠响应头比靠日志靠谱。
 */
export function serveCached(res, hit, method, extraHeaders = {}) {
  res.writeHead(200, {
    ...extraHeaders,
    'Content-Type': hit.ctype || 'application/octet-stream',
    'Content-Length': String(hit.bytes),
    'Cache-Control': IMG_CACHE_CONTROL,
    'X-Zeno-Cache': 'HIT',
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  const s = createReadStream(hit.path);
  // 文件可能在 writeHead 之后被人删掉。头已经发出去了，只能就地收尾
  s.on('error', () => res.end());
  s.pipe(res);
}

/**
 * 攒下一张图，流结束了再落盘。
 *
 * 为什么不用双写（pipe 到客户端的同时 pipe 到文件）：那套要自己管背压，
 * 两个下游谁慢都会把另一个饿着，出错时容易只清掉一半。
 * 单张上限 8MB、并发 6，最坏也就占住 48MB 内存，换来的是简单可靠。
 */
export function collector(url, ctype) {
  if (!cacheOn() || !isImage(ctype)) return null;
  const key = keyOf(url);
  const chunks = [];
  let size = 0;
  return {
    /** 返回 false 表示这张太大、不缓存了（转发照旧，不影响客户端） */
    push(chunk) {
      size += chunk.length;
      if (size > MAX_OBJECT_BYTES) {
        chunks.length = 0;
        return false;
      }
      chunks.push(chunk);
      return true;
    },
    async commit() {
      if (!chunks.length) return;
      const dir = cacheDir();
      const path = pathOf(dir, key);
      const tmp = `${path}.${randomUUID()}.part`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(tmp, Buffer.concat(chunks));
        renameSync(tmp, path);
        putRow(key, size, ctype);
        await evict();
      } catch (e) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          /* 临时文件都没建起来，没什么可清 */
        }
        // 盘满、目录被删、权限不对：吼一次然后继续不缓存地跑
        flag(`${dir} 写不进去：${e.message}`);
      }
    },
    drop() {
      chunks.length = 0;
    },
  };
}

/* ── 状态与管理 ───────────────────────────────────── */

export async function cacheStatus() {
  const dir = cacheDir();
  const { files, bytes } = totals();
  let freeBytes = null;
  if (dir) {
    try {
      const s = await statfs(dir);
      freeBytes = s.bsize * s.bavail;
    } catch {
      /* 目录还没建，或平台不支持 statfs */
    }
  }
  return {
    dir,
    enabled: cacheOn(),
    maxBytes: cacheMaxBytes(),
    files,
    bytes,
    freeBytes,
    defaultDir: join(dirname(dbPath()), 'cache'),
    warning,
  };
}

export async function setConfig({ dir, maxMb }) {
  const d = openDb();
  if (dir !== undefined) {
    const abs = assertCacheDir(dir);
    if (abs) await mkdir(abs, { recursive: true });
    // 换目录：旧目录的账本跟着作废，不然统计全是陈旧行
    if (abs !== cacheDir()) {
      d.prepare('DELETE FROM cache_index').run();
    }
    if (abs) kvSet('cache_dir', abs);
    else d.prepare('DELETE FROM kv_local WHERE key = ?').run('cache_dir');
    warned = false;
    warning = null;
  }
  if (maxMb !== undefined) {
    const n = Number(maxMb);
    if (!Number.isFinite(n) || n < 0) throw new Error('上限要是不小于 0 的数（0 = 关掉缓存）');
    kvSet('cache_max_mb', String(Math.round(n)));
  }
  await reconcile();
  return cacheStatus();
}

export async function clearCache() {
  const dir = cacheDir();
  if (dir) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (e) {
      flag(`清不掉 ${dir}：${e.message}`);
    }
  }
  openDb().prepare('DELETE FROM cache_index').run();
  return cacheStatus();
}

/* ── HTTP ─────────────────────────────────────────── */

/**
 * @returns {Promise<boolean>} 处理完了
 */
export async function handleCacheApi(req, res, url, auth) {
  const path = url.pathname;
  if (!path.startsWith('/api/cache')) return false;

  if (!auth(req)) {
    json(res, 401, { error: 'unauthorized' });
    return true;
  }

  try {
    if (path === '/api/cache' && req.method === 'GET') {
      json(res, 200, await cacheStatus());
      return true;
    }
    if (path === '/api/cache/config' && req.method === 'POST') {
      const body = await readBody(req);
      json(res, 200, await setConfig(body));
      return true;
    }
    if (path === '/api/cache/clear' && req.method === 'POST') {
      json(res, 200, await clearCache());
      return true;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, e.status ?? 400, { error: e.message });
  }
  return true;
}
