/**
 * 数据库自动备份
 *
 * 备份用 `VACUUM INTO`：它给的是**一致性快照**，不是直接拷三个文件。
 * 服务一直在写 WAL，直接 `copy zeno.db` 可能拿到"主库旧一半、WAL 新一半"
 * 的中间态；VACUUM INTO 由 SQLite 自己在读事务里生成完整副本。
 *
 * 默认每天一份、留 7 份。间隔和份数都能用环境变量改：
 *   ZENO_BACKUP_MS=0        关闭
 *   ZENO_BACKUP_KEEP=14     保留份数
 *   ZENO_BACKUP_DIR=...     备份目录（默认 data/backups）
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { dbPath, openDb } from './db.mjs';

const DEFAULT_EVERY_MS = 24 * 3600_000;
const DEFAULT_KEEP = 7;
/** 启动后先等一会儿再备份，别和冷启动时的迁移/对账抢盘 */
const FIRST_DELAY_MS = 15_000;

export function backupConfig() {
  const dir = resolve(process.env.ZENO_BACKUP_DIR || join(dirname(dbPath()), 'backups'));
  const keep = Math.max(1, Math.floor(Number(process.env.ZENO_BACKUP_KEEP) || DEFAULT_KEEP));
  const everyMs = Math.max(0, Number(process.env.ZENO_BACKUP_MS ?? DEFAULT_EVERY_MS));
  return { dir, keep, everyMs };
}

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `-${p(d.getMilliseconds(), 3)}`
  );
}

/** 只清理自己命名的文件，用户手动放进来的东西不碰 */
function backupFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => /^zeno-\d{8}-\d{6}-\d{3}(?:-\d+-\d+)?\.db$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

export function pruneBackups(dir, keep) {
  const files = backupFiles(dir);
  const excess = files.length - Math.max(0, keep);
  for (let i = 0; i < excess; i++) {
    try {
      rmSync(join(dir, files[i]), { force: true });
    } catch {
      /* 删不掉就留着，下次再试；备份多一份比启动失败好 */
    }
  }
  return backupFiles(dir);
}

/** 生成一份备份，返回文件路径 */
export function backupNow(when = new Date()) {
  const { dir, keep } = backupConfig();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `zeno-${stamp(when)}.db`);
  /*
   * 同一毫秒内重复调用会撞名；VACUUM INTO 遇到已存在的文件会报错，
   * 直接换一个后缀，别让一次定时任务失败。
   */
  let file = target;
  for (let n = 1; existsSync(file); n++) {
    file = target.replace(/\.db$/, `-${process.pid}-${n}.db`);
  }
  openDb().prepare('VACUUM INTO ?').run(file);
  pruneBackups(dir, keep);
  return file;
}

export function startBackupLoop(log = console) {
  const { dir, keep, everyMs } = backupConfig();
  if (!everyMs) return null;

  const run = () => {
    try {
      const file = backupNow();
      const mb = (statSync(file).size / 1048576).toFixed(1);
      log.log?.(`[zeno] 数据库已备份：${file}（${mb} MB，保留 ${keep} 份）`);
    } catch (e) {
      log.warn?.(`[zeno] 数据库备份失败：${e?.message ?? e}`);
    }
  };

  const first = setTimeout(run, FIRST_DELAY_MS);
  first.unref?.();
  const timer = setInterval(run, everyMs);
  timer.unref?.();

  return {
    dir,
    keep,
    everyMs,
    run,
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
