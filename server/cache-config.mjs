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
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readdir, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/**
 * 只属于这台机器的配置项。
 *
 * 导出的原因：预热的保留策略（留几章）跟缓存目录是同一类东西 —— 都是"这台盘怎么管"，
 * 都绝不该跟着 settings 同步到别的设备上去。再写一份 kv 助手只会让两边哪天不同步。
 */
export const localConfig = { get: kvGet, set: kvSet, drop: kvDrop };

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

/**
 * 给设置页的目录浏览器用：列某一个目录下的子目录。
 *
 * 为什么自己做而不是用浏览器的文件选择器：缓存目录是**服务端**这台机器的路径，
 * 而 showDirectoryPicker 选的是客户端（手机）的文件系统，
 * 而且出于沙箱设计它压根不返回绝对路径字符串。
 *
 * 只列目录，不给文件名 —— 这个端点的用途就是选位置，多列一个都不该多列。
 * 跟着符号链接/junction 看一层：数据盘经常是以链接的形式挂在那儿的，
 * 只认 isDirectory() 会把它们全漏掉。
 */
export async function browseDirs(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { path: null, parent: null, roots: true, entries: driveRoots() };
  if (!isAbsolute(raw)) throw Object.assign(new Error('只能浏览绝对路径'), { status: 400 });

  const dir = resolve(raw);
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    throw Object.assign(new Error(`读不了 ${dir}：${e.message}`), { status: 400 });
  }

  const entries = [];
  for (const d of names) {
    if (d.name.startsWith('.')) continue; // 点开头的目录噪音大
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    const p = join(dir, d.name);
    try {
      if (!statSync(p).isDirectory()) continue; // 链接指向文件的，不算
    } catch {
      continue; // 坏了的链接、没权限的，跳过而不是整页报错
    }
    entries.push({ name: d.name, path: p });
    if (entries.length >= MAX_ENTRIES) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' }));

  const up = dirname(dir);
  return {
    path: dir,
    parent: up === dir ? null : up,
    roots: false,
    truncated: entries.length >= MAX_ENTRIES,
    freeBytes: await freeOf(dir),
    entries,
  };
}

/**
 * 可浏览的根。
 *
 * Windows 上没有「列出所有盘符」的 API：readdir('\\') 返回的是当前盘根的内容
 * 而不是盘符（实测），所以只能逐盘 statSync 试 —— 26 次 stat，够快。
 * POSIX 侧 '/' 就已经能走到任何地方，另外把常见的挂载点也摆出来省几次点击。
 */
function driveRoots() {
  if (process.platform !== 'win32') {
    return ['/']
      .concat(['/mnt', '/media', '/home', '/data'].filter((p) => existsSync(p)))
      .map((p) => ({ name: p, path: p }));
  }
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const p = String.fromCharCode(c) + ':' + sep;
    try {
      if (statSync(p).isDirectory()) out.push({ name: p, path: p });
    } catch {
      /* 这个盘不存在 */
    }
  }
  return out;
}

async function freeOf(dir) {
  try {
    const s = await statfs(dir);
    return s.bsize * s.bavail;
  } catch {
    return null;
  }
}

/** 一次别回几千条：/usr/share 这种目录列完整身也没法看 */
const MAX_ENTRIES = 800;

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
