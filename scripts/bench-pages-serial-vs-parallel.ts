export {};

/**
 * 翻页到底该串行还是并行 —— 拿同一章的三页交替量
 *
 * 为什么要单独量这件事：上一版的"并行没变快"是拿整章耗时比的，
 * 而包子漫画的上游单页就要 0.8~1.5s，抖动比要省的这一点还大，
 * 两种策略各跑一次根本分不出来。只有把"同一章、同样的三页、交替多轮"
 * 摆在一起，才知道并行到底值不值。
 *
 * 用法：node scripts/bench-pages-serial-vs-parallel.mjs [轮数]
 */
const BASE = process.env.ZENO_PROXY || 'http://127.0.0.1:8788';
const SLUG = process.env.SLUG || 'woduzishengji-duburedicestudio';
const ID = process.argv[2] || '0_1';
const ROUNDS = Number(process.argv[3] || 3);

const urlFor = (page: number) =>
  `${BASE}/api/proxy?url=${encodeURIComponent(
    `https://www.twmanga.com/comic/chapter/${SLUG}/${page === 1 ? ID : `${ID}_${page}`}.html`,
  )}`;

const grab = async (page: number) => {
  const t0 = performance.now();
  const r = await fetch(urlFor(page));
  const html = await r.text();
  return { ms: performance.now() - t0, status: r.status, len: html.length };
};

const s: number[] = [];
const p: number[] = [];
for (let i = 0; i < ROUNDS; i++) {
  // 串行
  const a = [];
  for (const page of [1, 2, 3]) a.push(await grab(page));
  const serialMs = a.reduce((x, y) => x + y.ms, 0);
  // 并行（第 1 页必须先到手才知道有几页，所以只并行它之后的）
  const t0 = performance.now();
  const first = await grab(1);
  const rest = await Promise.all([grab(2), grab(3)]);
  const parMs = performance.now() - t0;
  s.push(serialMs);
  p.push(parMs);
  console.log(
    `第${i + 1}轮  串行 ${(serialMs / 1000).toFixed(2)}s [${a.map((x) => (x.ms / 1000).toFixed(2)).join(' ')}]` +
      `   并行 ${(parMs / 1000).toFixed(2)}s (${first.ms / 1000}+max ${rest
        .map((x) => (x.ms / 1000).toFixed(2))
        .join(',')})  状态 ${[first, ...rest].map((x) => x.status).join('')}`,
  );
}
const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
console.log(
  `\n平均：串行 ${(avg(s) / 1000).toFixed(2)}s  并行 ${(avg(p) / 1000).toFixed(2)}s  ` +
    `省 ${((avg(s) - avg(p)) / 1000).toFixed(2)}s（${(((avg(s) - avg(p)) / avg(s)) * 100).toFixed(0)}%）`,
);
