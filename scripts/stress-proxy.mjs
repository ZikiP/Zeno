/** 并发压测：模拟浏览器一次拉 38 张封面，验证限流后是否全 200 */
const BASE = 'http://127.0.0.1:8788/api/proxy?url=';
const COVERS = [
  'wodetudidushidafanpai-yuetian',
  'dafenggenggren',
  'shaosong',
  'yaoshenji',
  'wotianmingdafanpi',
  'douzhenjianghua',
  'wangyeyizhanshen',
  'shijianshijianshuiqingshen',
  'juquchuanqi',
  'feiyanxiongzhu',
  'nvyouqi',
  'wocaigongzhuqibing',
  'bingxueweixiong',
  'tiexueweixiong',
  'wuxiandoushen',
  'fengshen',
  'shendelongdan',
  'wanjie',
];

const urls = COVERS.map(
  (slug) =>
    BASE +
    encodeURIComponent(`https://static-tw.baozimh.com/cover/${slug}.jpg?w=300&h=400&q=85`),
);

const t0 = Date.now();
const results = await Promise.all(
  urls.map(async (u) => {
    try {
      const r = await fetch(u);
      return r.ok ? r.status : r.status;
    } catch (e) {
      return `ERR ${e.message}`;
    }
  }),
);

const codes = results.reduce((acc, c) => {
  acc[c] = (acc[c] ?? 0) + 1;
  return acc;
}, {});

console.log(`并发 ${urls.length} 张封面，耗时 ${Date.now() - t0}ms`);
console.log('状态码分布:', JSON.stringify(codes));
const allOk = results.every((c) => c === 200);
console.log(allOk ? 'PASS 全部 200' : 'FAIL 有失败');
process.exit(allOk ? 0 : 1);
