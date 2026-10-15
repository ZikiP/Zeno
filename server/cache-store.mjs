/**
 * 图片缓存的盘上机制：键、账本、淘汰、读写
 *
 * 文件按 URL 的 sha256 命名，前两位分片 —— 一本书几千张图全堆在一个目录里，
 * readdir 会开始变慢。账本在 sqlite 的 cache_index 表里，记字节数和
 * 「最后一次被访问」，淘汰按后者排。
 */
import { randomUUID, createHash } from 'node:crypto';
import { readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { openDb } from './db.mjs';
import { cacheDir, cacheMaxBytes, cacheOn, flag } from './cache-config.mjs';

/** 单张图的上限。漫画页一般 100KB~2MB，超过这个数多半不是图 */
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

const keyOf = (url) => createHash('sha256').update(url).digest('hex');

const shardOf = (key) => key.slice(0, 2);

const pathOf = (dir, key) => join(dir, shardOf(key), key);

/* ── 账本 ─────────────────────────────────────────── */

export function totals() {
  const r = openDb()
    .prepare('SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM cache_index')
    .get();
  return { files: r.files, bytes: r.bytes };
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

export function wipeIndex() {
  openDb().prepare('DELETE FROM cache_index').run();
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
     * 盘上有文件但账本没记（升级前存的、手动拷进来的）：读文件头认类型。
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

/** 只读文件头 12 字节，对账几万张图也不至于把盘读完 */
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
  const rows = openDb().prepare('SELECT key, bytes FROM cache_index ORDER BY at ASC').all();
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
 * 该不该按图片存盘 / 给图片的 Cache-Control。
 *
 * 光看 Content-Type 不够：实测有站的封面走的是 CDN 的原图路径，
 * 回的是 `binary/octet-stream` —— 按类型判就不是图，于是一张封面都不进盘，
 * 每屏列表都回源重取，缓存看着开着其实没起作用。
 *
 * 所以放行条件是「类型是 image/*，或者 URL 看着是图且类型不是 text/*」。
 * 加上后半句的类型限制是为了挡住另一种情况：`.jpg` 地址上回一整页 HTML 报错，
 * 那东西存进盘就是一颗一天的雷。
 */
export function cacheableAsImage(ctype, url) {
  if (isImage(ctype)) return true;
  const ct = (ctype ?? '').toLowerCase();
  if (ct.startsWith('text/')) return false;
  return /^https?:\/\/[^\s?#]+\.(?:jpg|jpeg|png|webp|gif|avif|bmp)(?:[?#]|$)/i.test(String(url));
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
  openDb().prepare('UPDATE cache_index SET at = ? WHERE key = ?').run(Date.now(), key);
  return { key, path, bytes: row.bytes, ctype: row.ctype };
}

/**
 * 攒下一张图，流结束了再落盘。
 *
 * 为什么不用双写（pipe 到客户端的同时 pipe 到文件）：那套要自己管背压，
 * 两个下游谁慢都会把另一个饿着，出错时容易只清掉一半。
 * 单张上限 8MB、并发 8，最坏也就占住 64MB 内存，换来的是简单可靠。
 */
export function collector(url, ctype) {
  if (!cacheOn() || !cacheableAsImage(ctype, url)) return null;
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
  };
}

/** 整个目录连账一起清掉 */
export async function wipeFiles() {
  const dir = cacheDir();
  if (!dir) return;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (e) {
    flag(`清不掉 ${dir}：${e.message}`);
  }
}
