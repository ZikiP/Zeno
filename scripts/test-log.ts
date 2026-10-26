/**
 * 日志轮转
 *
 * 钉住：超过上限会归档、只保留最近 N 份、归档名可被下一次轮转识别。
 * 只写临时目录，不碰仓库里的 zeno.log。
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'zeno-log-test-'));
const file = join(dir, 'zeno.log');
process.env.ZENO_LOG_FILE = file;
process.env.ZENO_LOG_MAX_BYTES = '1024';
process.env.ZENO_LOG_KEEP = '2';
process.env.ZENO_LOG_ECHO = '1';

const { installRotatingLog, logConfig } = await import('../server/log.mjs');

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};
const archives = () =>
  readdirSync(dir)
    .filter((f) => /^zeno\.log\.\d{8}-\d{6}-\d{3}(?:-\d+)?$/.test(f))
    .sort();

try {
  check(logConfig()?.maxBytes === 1024, '配置从环境变量读入');
  installRotatingLog();

  console.log('=== 1. 超过上限会归档 ===');
  for (let i = 0; i < 6; i++) console.log(`line-${i} ` + 'x'.repeat(180));
  const first = archives();
  check(first.length >= 1, `生成了归档（${first.length} 份）`);
  check(readdirSync(dir).includes('zeno.log'), '当前日志文件仍在');

  console.log('\n=== 2. 归档只留最近 N 份 ===');
  for (let i = 0; i < 8; i++) console.log(`more-${i} ` + 'y'.repeat(180));
  const kept = archives();
  check(kept.length <= 2, `归档不超过 ${logConfig()?.keep} 份（实际 ${kept.length}）`);
  check(
    kept.every((f) => /^zeno\.log\.\d{8}-\d{6}-\d{3}(?:-\d+)?$/.test(f)),
    '归档命名可被下一次轮转识别',
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(56));
if (fails) {
  console.log(`  ${fails} 项失败`);
  process.exit(1);
}
console.log('  全部通过 — 日志按大小轮转且保留份数受控');
