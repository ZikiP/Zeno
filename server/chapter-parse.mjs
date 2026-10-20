/**
 * 服务端的章节表解析
 *
 * 从 updates.mjs 拆出来，是为了能放进 worker：插件提供的 chapterIdFrom 是
 * 原样正则，嵌套量词写坏就能在 Node 主线程里卡死。worker 里跑、超时就 terminate，
 * 至少不会把整个服务拖住。
 *
 * 规则与客户端 parseChapters 的一致性由 scripts/test-updates.ts 钉住。
 */

/** 和 src/site/text.ts 的 decodeEntities 一条不差 */
export function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

export function countChapters(html, parse) {
  return listChapters(html, parse).length;
}

/**
 * 章节表：id + 阅读顺序，按 index 升序。
 *
 * index 的来路和客户端一条不差：id 正则捕到两组以上时，第二组就是序号
 * （`section_slot=0&chapter_slot=562` → `0_562`，页面顺序未必是章节顺序）；
 * 只捕到一组时按它们在页面里出现的先后排。
 */
export function listChapters(html, parse) {
  const body = decodeEntities(html);
  const itemRe = new RegExp(
    `<a[^>]*${escapeRe(parse.chapterItem)}[^>]*>([\\s\\S]{0,300}?)</a>`,
    'gi',
  );
  const idRe = new RegExp(parse.chapterIdFrom);
  const out = [];
  const seen = new Set();
  let m;
  while ((m = itemRe.exec(body))) {
    const inner = m[1] ?? '';
    const attrs = m[0].slice(0, m[0].indexOf('>'));
    const hrefM = attrs.match(/href="([^"]+)"/) ?? inner.match(/href="([^"]+)"/);
    if (!hrefM) continue;
    const href = hrefM[1].replace(/&amp;/g, '&').replace(/&#x2F;/g, '/');
    const idM = href.match(idRe);
    if (!idM) continue;
    const numbered = idM.length >= 3;
    const raw = numbered ? idM[2] : idM[1];
    if (!raw) continue;
    const id = numbered ? `${idM[1] ?? '0'}_${raw}` : raw;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, index: numbered ? Number(raw) || 0 : out.length + 1 });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
