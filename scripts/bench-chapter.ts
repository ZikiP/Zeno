/**
 * 「翻开一章」到拿到全部图片地址，端到端多久
 *
 * 这是阅读页最慢的一段，而且它不在浏览器 profiler 里好看 ——
 * 中间是几个串行的上游往返，卡的是网络等待，CPU 几乎没动。
 *
 * 用法：ZENO_PROXY=http://127.0.0.1:8788 npx tsx scripts/bench-chapter.ts [slug] [章节id...]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from '../src/site/types';
import { getChapter } from '../src/site/engine';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = JSON.parse(
  readFileSync(resolve(ROOT, '../zeno-plugins/plugins/baozimh.json'), 'utf8'),
) as Plugin;

const slug = process.argv[2] ?? 'woduzishengji-duburedicestudio';
const ids = process.argv.slice(3).length ? process.argv.slice(3) : ['0_1', '0_20', '0_200'];

for (const id of ids) {
  const t0 = performance.now();
  const page = await getChapter(plugin, slug, id);
  const ms = performance.now() - t0;
  console.log(
    `${id.padEnd(8)} ${String(page.images.length).padStart(3)}张  ${(ms / 1000).toFixed(2)}s` +
      `  标称页数=${page.totalPages}${page.truncated ? '  [被截断]' : ''}`,
  );
}
