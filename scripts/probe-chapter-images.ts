/**
 * 章节图片逐张过代理，看哪一台图床挂了。
 * 用法：ZENO_PROXY=http://127.0.0.1:8788 npx tsx scripts/probe-chapter-images.ts <plugin json> <slug> <chapterId>
 */
import { readFileSync } from 'node:fs';
import type { Plugin } from '../src/site/types';
import { getChapter } from '../src/site/engine';

const [, , pluginPath, slug, chapterId] = process.argv;
/** 图片地址是被代理包过的，要看的图床在 ?url= 里 */
function realUrl(proxiedUrl: string): string {
  try {
    const u = new URL(proxiedUrl);
    if (u.pathname === '/api/proxy') return u.searchParams.get('url') ?? proxiedUrl;
  } catch {
    /* 相对地址在 Node 里没有意义，直接原样返回 */
  }
  return proxiedUrl;
}

const plugin = JSON.parse(readFileSync(pluginPath, 'utf8')) as Plugin;
const page = await getChapter(plugin, slug, chapterId);
console.log('图片数', page.images.length, '| 总页数', page.totalPages);
const hosts = new Map<string, number>();
for (const u of page.images) {
  const h = new URL(realUrl(u)).hostname;
  hosts.set(h, (hosts.get(h) ?? 0) + 1);
}
console.log('图床分布', [...hosts]);

for (const u of page.images.slice(0, 4)) {
  const t = Date.now();
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(30_000) });
    const buf = await r.arrayBuffer();
    console.log(r.status, `${buf.byteLength}B`, `${((Date.now() - t) / 1000).toFixed(2)}s`, realUrl(u).slice(0, 150));
  } catch (e) {
    console.log('抛出', (e as Error).message, u.slice(0, 150));
  }
}
