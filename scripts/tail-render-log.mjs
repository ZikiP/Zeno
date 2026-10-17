/**
 * 读 zeno.log 从某个字节偏移往后的 [zeno][render] 行（跳过刷屏的子资源行）。
 * 用法：node scripts/tail-render-log.mjs <偏移>
 */
import fs from 'node:fs';

const LOG = process.argv[2] || 'D:/workspace/Zeno/zeno.log';
const from = Number(process.argv[3] || 0);
const buf = fs.readFileSync(LOG);
const text = buf.subarray(from).toString('utf8');
const onlyDoc = process.argv.includes('--doc-only');
const lines = text.split(/\r?\n/);
let shown = 0;
for (const l of lines) {
  if (!l.includes('[zeno]')) continue;
  if (onlyDoc) {
    if (!/→ document|HTTP |停在|未返回|页面报错/.test(l)) continue;
  } else if (/→ image|→ font|→ media/.test(l)) {
    continue;
  }
  console.log(l.slice(0, 200));
  if (++shown > 400) break;
}
console.log(`(共 ${lines.length} 行，从偏移 ${from})`);
