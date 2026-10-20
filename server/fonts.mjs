/**
 * 自定义字体：扫描服务端的字体目录，把 zip 包 / 散装字体识别成可选项
 *
 * 目录里放 .zip（解压找里面的字体）或直接放 .ttf/.otf/.woff/.woff2。
 * 字族名从字体内部的 name 表读（中文/英文名都认），不靠文件名猜；
 * woff2 的表是 Brotli 压缩 + 变形的，解析不值当，退回文件名。
 *
 * 目录路径存 kv_local 而不是 settings —— 和缓存目录同一道理：
 * 那是这台机器的磁盘路径，同步到手机上纯属垃圾。
 * 但「选了哪个字体」走多端同步（客户端的 uiFont 键），
 * 因为字体文件本来就由这个服务端供给，任何设备都拉得到。
 *
 * 文件端点按内容签名发 immutable 缓存头：id 里掺了源文件 mtime，
 * 换了字体包 id 就变，旧的缓存自然作废，不需要失效逻辑。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';

import { dbPath, openDb } from './db.mjs';
import { assertCacheDir } from './cache-config.mjs';
import { json, readBody } from './respond.mjs';

/** 单个 zip 超过这个数就当它不是字体包，跳过（正常中文字体包 5–30MB） */
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_FACES = 300;

const FONT_FILE_EXT = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

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

/** 没配过时的落点：数据库旁边，装完就有 */
export function defaultFontsDir() {
  return join(dirname(resolve(dbPath())), 'fonts');
}

export function fontsDir() {
  const saved = kvGet('fonts_dir');
  if (saved !== null) return saved;
  return process.env.ZENO_FONTS_DIR || defaultFontsDir();
}

export function saveFontsDir(dir) {
  if (dir) kvSet('fonts_dir', dir);
  else kvDrop('fonts_dir');
}

/* ── 字体内部元数据 ───────────────────────────────── */

function utf16be(raw) {
  // 必须先把字节拷出来：subarray 共享底层内存，swap16 是原地改，
  // 直接在切片上 swap 会把字体缓冲区一起搅乱（实测字族名错位一个字节）。
  const buf = Buffer.from(raw);
  buf.swap16();
  return buf.toString('utf16le');
}

/**
 * 解析 sfnt（ttf/otf/ttc 的第一枚）的 name + OS/2 表。
 * 拿不到（表缺失、截断、非字体）返回 null，调用方退回文件名。
 */
function parseSfnt(buf) {
  try {
    const tag = buf.toString('latin1', 0, 4);
    let base = 0;
    if (tag === 'ttcf') base = buf.readUInt32BE(16); // 取集合里第一枚
    else if (buf.readUInt32BE(0) !== 0x00010000 && tag !== 'true' && tag !== 'OTTO') return null;

    const numTables = buf.readUInt16BE(base + 4);
    let nameOff = -1, nameLen = 0, os2Off = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      const t = buf.toString('latin1', rec, rec + 4);
      if (t === 'name') { nameOff = buf.readUInt32BE(rec + 8); nameLen = buf.readUInt32BE(rec + 12); }
      else if (t === 'OS/2') os2Off = buf.readUInt32BE(rec + 8);
    }
    if (nameOff < 0 || nameOff + nameLen > buf.length) return null;

    // name 表头：uint16 format / uint16 count / uint16 stringOffset。
    // stringOffset 相对**表起点**（已含 6 字节头），不能再自己加一截。
    const count = buf.readUInt16BE(nameOff + 2);
    const strBase = nameOff + buf.readUInt16BE(nameOff + 4);
    /** nameID → 字符串。平台 3（Windows，UTF-16）优先，其次 1（Mac，latin1） */
    const names = new Map();
    for (let i = 0; i < count; i++) {
      const r = nameOff + 6 + i * 12;
      const platform = buf.readUInt16BE(r);
      const lang = buf.readUInt16BE(r + 4);
      const id = buf.readUInt16BE(r + 6);
      if (platform !== 3 && platform !== 1) continue;
      // 同名记录有多语言副本：平台 3 优先于 1，en-US/zh-CN 优先于其它，同级留第一个
      const win = platform === 3;
      const pref = (l) => (l === 1033 || l === 2052 ? 2 : 1);
      const prev = names.get(id);
      if (prev && (win < prev.win || (win === prev.win && pref(lang) <= pref(prev.lang)))) continue;
      const len = buf.readUInt16BE(r + 8);
      const off = strBase + buf.readUInt16BE(r + 10);
      if (off + len > buf.length) continue;
      const raw = buf.subarray(off, off + len);
      names.set(id, { win, lang, text: win ? utf16be(raw) : raw.toString('latin1') });
    }
    const get = (id) => names.get(id)?.text?.trim() || '';
    // 16/17 是排版族/子族：比 1/2 更准（1/2 会把 Bold 挤进同一个"家族"）
    const family = get(16) || get(1);
    if (!family) return null;
    const subfamily = get(17) || get(2);
    const weight = os2Off >= 0 ? buf.readUInt16BE(os2Off + 4) : /bold|black|heavy/i.test(subfamily) ? 700 : 400;
    return { family, subfamily, weight, style: /italic|oblique/i.test(subfamily) ? 'italic' : 'normal' };
  } catch {
    return null;
  }
}

/** woff/woff2 解析不动，从文件名猜 */
function guessFromName(fileName) {
  const stem = basename(fileName, extname(fileName)).replace(/\.(ttf|otf|ttc|woff2?|zip)$/i, '');
  const clean = stem
    .replace(/[-_ ]?(regular|bold|italic|light|medium|thin|black|semibold|demibold|extrabold|medium|oblique|vf|variable)/gi, '')
    .replace(/[-_ ]+$/, '')
    .trim();
  const family = clean || stem;
  const weight = /black|heavy/i.test(stem) ? 900 : /extrabold|bold/i.test(stem) ? 700 : /semibold|demibold/i.test(stem) ? 600 : /medium/i.test(stem) ? 500 : /light/i.test(stem) ? 300 : 400;
  return { family, subfamily: stem.slice(family.length).replace(/^[-_\s]+/, '') || 'Regular', weight, style: /italic|oblique/i.test(stem) ? 'italic' : 'normal' };
}

/* ── 扫描 ─────────────────────────────────────────── */

/** 目录签名：文件名+mtime。没变就不重开 zip */
async function dirSignature(dir) {
  const names = await readdir(dir);
  const parts = [];
  for (const n of names.sort()) {
    try {
      const s = await stat(join(dir, n));
      if (s.isFile()) parts.push(`${n}:${Math.round(s.mtimeMs)}`);
    } catch {
      /* 正被弹出的 U 盘之类，跳过 */
    }
  }
  return parts.join('|');
}

let cache = { dir: null, sig: '', fonts: [], files: new Map(), warning: null };

function faceId(file, mtimeMs, entry, family, subfamily) {
  return createHash('sha1').update(`${basename(file)}|${mtimeMs}|${entry || ''}|${family}|${subfamily}`).digest('hex').slice(0, 16);
}

function addFace(byFamily, files, meta, id) {
  if (!meta || files.size >= MAX_FACES) return;
  const fam = meta.family.trim();
  if (!fam) return;
  let g = byFamily.get(fam);
  if (!g) { g = { family: fam, faces: [] }; byFamily.set(fam, g); }
  if (g.faces.some((f) => f.style === meta.style && f.weight === meta.weight)) return; // 同族同字重留第一个
  g.faces.push({ id, subfamily: meta.subfamily || 'Regular', weight: meta.weight, style: meta.style });
  files.set(id, { file: meta.__file, entry: meta.__entry, ext: meta.__ext });
}

/** 从一整个目录扫出字体。refresh 时忽略签名缓存 */
export async function scanFonts(refresh = false) {
  const dir = fontsDir();
  let sig = '';
  try {
    sig = await dirSignature(dir);
  } catch (e) {
    if (existsSync(dir)) return { dir, fonts: [], warning: `读不了这个目录：${e.message}` };
    return { dir, fonts: [], warning: null }; // 还没建目录 = 一个字体都没有，不是错误
  }
  if (!refresh && cache.dir === dir && cache.sig === sig) {
    return { dir, fonts: cache.fonts, warning: cache.warning };
  }

  const byFamily = new Map();
  const files = new Map();
  const notes = [];
  const entries = (await readdir(dir)).sort((a, b) => a.localeCompare(b, 'zh-CN', { sensitivity: 'base' }));
  for (const name of entries) {
    const p = join(dir, name);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (!s.isFile()) continue;
    const ext = extname(name).toLowerCase();
    const mtimeMs = Math.round(s.mtimeMs);

    if (ext === '.zip') {
      if (s.size > MAX_ZIP_BYTES) { notes.push(`${name} 太大，跳过了`); continue; }
      let data;
      try { data = readFileSync(p); } catch { continue; }
      let unzipped;
      try {
        // 只解字体条目：包里的图片/文档不配进内存
        unzipped = unzipSync(data, { filter: (f) => !f.name.endsWith('/') && /\.(ttf|otf|ttc|woff2?)$/i.test(f.name) });
      } catch {
        notes.push(`${name} 解压失败（可能损坏或加密）`);
        continue;
      }
      for (const [entryName, bytes] of Object.entries(unzipped)) {
        const eext = extname(entryName).toLowerCase();
        const inner = basename(entryName).replace(/\\/g, '/');
        // fflate 给的是 Uint8Array，不是 Buffer —— 不转的话 toString('latin1') 直接抛
        const meta = eext === '.woff2' || eext === '.woff' ? guessFromName(inner) : parseSfnt(Buffer.from(bytes));
        const src = meta || guessFromName(inner);
        src.__file = p; src.__entry = entryName; src.__ext = eext;
        addFace(byFamily, files, src, faceId(p, mtimeMs, entryName, src.family, src.subfamily));
      }
    } else if (ext in FONT_FILE_EXT) {
      let data;
      try { data = readFileSync(p); } catch { continue; }
      const meta = ext === '.woff2' || ext === '.woff' ? guessFromName(name) : parseSfnt(data);
      const src = meta || guessFromName(name);
      src.__file = p; src.__entry = null; src.__ext = ext;
      addFace(byFamily, files, src, faceId(p, mtimeMs, null, src.family, src.subfamily));
    }
  }

  const fonts = [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family, 'zh-CN', { sensitivity: 'base' }));
  const warning = notes.length ? notes.join('；') : null;
  cache = { dir, sig, fonts, files, warning };
  return { dir, fonts, warning };
}

/** 按 id 取字体字节。id 只可能来自上一次扫描，天然没有路径穿越 */
function readFace(id) {
  const loc = cache.files.get(id);
  if (!loc) return null;
  try {
    if (loc.entry) {
      const unzipped = unzipSync(readFileSync(loc.file), { filter: (f) => f.name === loc.entry });
      const bytes = Object.values(unzipped)[0];
      return bytes ? Buffer.from(bytes) : null;
    }
    return readFileSync(loc.file);
  } catch {
    return null;
  }
}

/**
 * 字体端点的 gzip 缓存。字体是 immutable 的，按 id 存一份。
 *
 * 按“总压缩字节”封顶而不是条目数：一个中文字体就能有 7MB，8 个就是 60MB
 * 常驻，MiniPC 上不值得。默认 24MB，放不下就逐出最早的那份；单份超过上限
 * 的直接不缓存，免得一份把整个预算吃光。
 */
const gzipFaces = new Map();
const GZIP_FACE_MAX_BYTES = Math.max(
  0,
  Number(process.env.ZENO_FONT_GZIP_MAX_MB || 24) * 1024 * 1024,
);

function gzipFont(id, bytes) {
  const hit = gzipFaces.get(id);
  if (hit && hit.size === bytes.length) return hit.bytes;

  const out = gzipSync(bytes, { level: 6 });
  if (!GZIP_FACE_MAX_BYTES || out.length > GZIP_FACE_MAX_BYTES) return out;

  let total = 0;
  for (const v of gzipFaces.values()) total += v.bytes.length;
  while (total + out.length > GZIP_FACE_MAX_BYTES && gzipFaces.size) {
    const [oldKey, old] = gzipFaces.entries().next().value;
    gzipFaces.delete(oldKey);
    total -= old.bytes.length;
  }
  gzipFaces.set(id, { size: bytes.length, bytes: out });
  return out;
}

/* ── HTTP ─────────────────────────────────────────── */

/**
 * @returns {Promise<boolean>} 已经处理完了
 */
export async function handleFontsApi(req, res, url, auth) {
  const path = url.pathname;
  if (!path.startsWith('/api/fonts')) return false;

  if (!auth(req)) {
    json(res, 401, { error: 'unauthorized' });
    return true;
  }

  try {
    if (path === '/api/fonts' && req.method === 'GET') {
      json(res, 200, await payload());
      return true;
    }
    if (path === '/api/fonts/config' && req.method === 'POST') {
      const body = await readBody(req);
      const dir = assertCacheDir(body.dir ?? ''); // 校验规则和缓存目录完全一样：绝对路径、不进应用目录
      if (dir) mkdirSync(dir, { recursive: true });
      saveFontsDir(dir);
      json(res, 200, await payload(true));
      return true;
    }
    if (path === '/api/fonts/rescan' && req.method === 'POST') {
      json(res, 200, await payload(true));
      return true;
    }
    if (path === '/api/fonts/file' && (req.method === 'GET' || req.method === 'HEAD')) {
      const id = url.searchParams.get('id') || '';
      let bytes = readFace(id);
      if (!bytes) {
        await scanFonts(true); // 可能刚重启，缓存是空的
        bytes = readFace(id);
      }
      if (!bytes) {
        json(res, 404, { error: '字体不存在，可能被删了或换了目录。重新扫描试试。' });
        return true;
      }
      const ext = cache.files.get(id).ext;
      /*
       * 中文字体包动辄十几 MB，而这个端点直连 HTTP、前面没有 nginx 代压。
       * ttf/otf/ttc 是裸二进制，gzip 能砍掉近一半；woff/woff2 自带压缩，跳过。
       * id 里掺了源文件 mtime，换字体包 id 就变，所以按 id 缓存压好的字节是安全的。
       */
      const compressible = ext === '.ttf' || ext === '.otf' || ext === '.ttc';
      const wantGzip = compressible && /\bgzip\b/i.test(req.headers['accept-encoding'] ?? '');
      const body = wantGzip ? gzipFont(id, bytes) : bytes;
      const headers = {
        'Content-Type': FONT_FILE_EXT[ext] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
      };
      if (compressible) headers.Vary = 'Accept-Encoding';
      if (wantGzip) headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, e.status ?? 400, { error: e.message });
  }
  return true;
}

async function payload(refresh = false) {
  const r = await scanFonts(refresh);
  return { ...r, defaultDir: defaultFontsDir() };
}
