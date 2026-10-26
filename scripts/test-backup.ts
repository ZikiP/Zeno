/**
 * 数据库备份
 *
 * 钉三件事：
 *   1. 备份文件能独立打开，里面的数据是备份那一刻的完整快照；
 *   2. 按保留份数清理，只删自己命名的文件；
 *   3. 同一毫秒重复备份不撞名。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'zeno-backup-test-'));
process.env.DB_PATH = join(dir, 'zeno.db');
process.env.ZENO_BACKUP_DIR = join(dir, 'backups');
process.env.ZENO_BACKUP_KEEP = '2';

const { DatabaseSync } = await import('node:sqlite');
const { openDb } = await import('../server/db.mjs');
const { backupNow, backupConfig, pruneBackups } = await import('../server/backup.mjs');

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};
const backups = () => readdirSync(process.env.ZENO_BACKUP_DIR!).filter((f) => f.endsWith('.db')).sort();

try {
  const db = openDb();
  db.prepare(
    'INSERT INTO settings (key, value, updated_at, device_id) VALUES (?, ?, ?, ?)',
  ).run('themeMode', '"dark"', Date.now(), 'test');

  console.log('=== 1. 一致性快照 ===');
  const first = backupNow(new Date('2026-01-01T00:00:00Z'));
  const copy = new DatabaseSync(first, { readOnly: true });
  const row = copy.prepare("SELECT value FROM settings WHERE key = 'themeMode'").get() as
    | { value: string }
    | undefined;
  check(row?.value === '"dark"', '备份里能读到备份前的数据');
  copy.close();
  check(backups().length === 1, '生成了一份备份');

  console.log('\n=== 2. 保留份数与命名 ===');
  backupNow(new Date('2026-01-02T00:00:00Z'));
  backupNow(new Date('2026-01-03T00:00:00Z'));
  const kept = backups();
  check(kept.length === 2, `只保留 ${backupConfig().keep} 份（实际 ${kept.length}）`);
  check(
    kept.every((f) => /^zeno-\d{8}-\d{6}-\d{3}\.db$/.test(f)),
    '只保留自己命名的备份文件',
  );
  check(!kept.includes(first.split(/[\\/]/).pop()!), '最旧的一份被清掉');

  console.log('\n=== 3. 不碰用户文件 / 重复备份 ===');
  const userFile = join(process.env.ZENO_BACKUP_DIR!, 'notes.txt');
  writeFileSync(userFile, 'keep me');
  pruneBackups(process.env.ZENO_BACKUP_DIR!, 2);
  check(existsSync(userFile), '不删目录里不是自己命名的文件');

  process.env.ZENO_BACKUP_KEEP = '5';
  const a = backupNow(new Date('2026-01-03T00:00:00Z'));
  const b = backupNow(new Date('2026-01-03T00:00:00Z'));
  check(a !== b && existsSync(a) && existsSync(b), '同一毫秒重复备份会换名，不静默失败');
} finally {
  try {
    openDb().close();
  } catch {
    /* 已被测试自己关掉也无所谓 */
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(56));
if (fails) {
  console.log(`  ${fails} 项失败`);
  process.exit(1);
}
console.log('  全部通过 — 备份是可读快照，保留策略生效');
