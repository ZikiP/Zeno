/**
 * 按大小轮转的日志
 *
 * 计划任务把 stdout 重定向到 zeno.log，进程一跑几周文件就无限长。
 * 这里接管 console：照常输出到 stdout，同时写一份带时间戳的 zeno.log，
 * 超过上限就改名归档、只留最近几份。
 *
 * 只有设置了 ZENO_LOG_FILE 才启用 —— 测试和前台跑不应该往仓库里写日志。
 *   ZENO_LOG_FILE=./zeno.log
 *   ZENO_LOG_MAX_BYTES=5242880
 *   ZENO_LOG_KEEP=5
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { format } from 'node:util';

const FILE = process.env.ZENO_LOG_FILE ? resolve(process.env.ZENO_LOG_FILE) : '';
const MAX_BYTES = Math.max(1024, Number(process.env.ZENO_LOG_MAX_BYTES) || 5 * 1024 * 1024);
const KEEP = Math.max(1, Math.floor(Number(process.env.ZENO_LOG_KEEP) || 5));

let bytes = 0;
let installed = false;

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

/** 只认 `<base>.<时间戳>` 这种归档名，用户手放的日志不碰 */
function archives() {
  const base = basename(FILE);
  try {
    return readdirSync(dirname(FILE))
      .filter(
        (f) =>
          f.startsWith(`${base}.`) &&
          /^\d{8}-\d{6}-\d{3}(?:-\d+)?$/.test(f.slice(base.length + 1)),
      )
      .sort();
  } catch {
    return [];
  }
}

function prune() {
  const list = archives();
  for (const f of list.slice(0, Math.max(0, list.length - KEEP))) {
    try {
      rmSync(join(dirname(FILE), f), { force: true });
    } catch {
      /* 删不掉就留着，下次再试 */
    }
  }
}

function rotate() {
  if (!FILE || !existsSync(FILE)) {
    bytes = 0;
    return;
  }
  const size = statSync(FILE).size;
  if (size < MAX_BYTES) {
    bytes = size;
    return;
  }
  try {
    let archive = `${FILE}.${stamp()}`;
    for (let n = 1; existsSync(archive); n++) archive = `${FILE}.${stamp()}-${n}`;
    renameSync(FILE, archive);
    bytes = 0;
    prune();
  } catch {
    /* 轮转失败不能影响服务；继续追加，下次再试 */
    bytes = size;
  }
}

export function installRotatingLog() {
  if (!FILE || installed) return FILE || null;
  mkdirSync(dirname(FILE), { recursive: true });
  rotate();

  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      try {
        const line = `${new Date().toISOString()} ${level.toUpperCase()} ${format(...args)}\n`;
        const n = Buffer.byteLength(line);
        if (bytes + n > MAX_BYTES) rotate();
        appendFileSync(FILE, line, 'utf8');
        bytes += n;
      } catch {
        /* 日志写不进去也不能把请求带崩 */
      }
    };
  }
  installed = true;
  return FILE;
}

export function logConfig() {
  return FILE ? { file: FILE, maxBytes: MAX_BYTES, keep: KEEP } : null;
}
