/**
 * 图片缓存的配置与健康状态
 *
 * 「这台机器上缓存放哪儿、最多放多少」只属于本机，所以存在 kv_local
 * 而不是 settings —— settings 参与多端同步，把一台机器的 D:\ 路径
 * 同步到手机上纯属垃圾。
 *
 * 这里还管着一个进程内的降级状态：盘写不进去（满、权限、目录被删）时
 * 吼一次就闭嘴，之后安静地不缓存。缓存不该把正常请求拖成 502。
 */
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { dbPath, openDb } from './db.mjs';

const DEFAULT_MAX_MB = Number(process.env.ZENO_CACHE_MAX_MB || 512);
const ENV_DIR = process.env.ZENO_CACHE_DIR || '';

let warning = null;
let warned = false;

function kvGet(key) {
  const row = openDb().prepare('SELECT value FROM kv_local WHERE key = ?').get(key);
  return row ? row.value : null;
}

function kvSet(key, value) {
  openDb()
    .prepare('INSERT INTO kv_local (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function kvDrop(key) {
  openDb().prepare('DELETE FROM kv_local WHERE key = ?').run(key);
}

/** 没配过时的落点：数据库旁边，同一块盘，装完就有 */
export function defaultCacheDir() {
  return join(dirname(dbPath()), 'cache');
}

/**
 * 缓存目录。空串表示显式关掉。
 *
 * env 里的值只在没人配过的时候生效 —— 设置页改过一次之后就该听设置页的，
 * 否则改目录这件事在带 env 的部署里永远改不动。
 */
export function cacheDir() {
  const saved = kvGet('cache_dir');
  if (saved !== null) return saved;
  return ENV_DIR || defaultCacheDir();
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
   * rel 不以 .. 开头、且不可能是绝对路径，才说明它还在应用目录里面。
   * 后半个判断不能省：Windows 上跨盘符时 relative('D:\\x','C:\\y')
   * 直接返回 'C:\\y' 这个绝对路径本身，只看开头会把 D 盘应用之外的
   * 每个目录都误判成"指进了应用目录"。
   */
  if (abs === appRoot || (rel && !rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`不能指到应用目录里面（${appRoot}）。换个盘或换个目录。`);
  }
  return abs;
}

/** 存目录。传空串 = 回到默认（不是"关掉"，关掉是把上限设 0） */
export function saveCacheDir(dir) {
  if (dir) kvSet('cache_dir', dir);
  else kvDrop('cache_dir');
}

export function saveCacheMaxMb(n) {
  kvSet('cache_max_mb', String(Math.round(n)));
}

/** 目录得当场建出来，否则用户要到第一张图落盘时才发现路径写错了 */
export function ensureCacheDir(dir) {
  if (dir) mkdirSync(dir, { recursive: true });
}

export function flag(msg) {
  if (!warned) {
    warned = true;
    console.warn(`[zeno] 图片缓存已停用：${msg}`);
  }
  warning = msg;
}

export const getWarning = () => warning;

/** 换了目录就是换了一块盘，旧的报错不该继续挂着 */
export function resetWarning() {
  warned = false;
  warning = null;
}
