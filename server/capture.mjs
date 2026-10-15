/**
 * 页面内数据捕获
 *
 * 有些站把章节正文的地址放在**只有执行它的 JS 才拿得到**的位置：接口回文是
 * 加密的，站点自己的代码解密后交给 JSON.parse，再由框架挂进 DOM —— 而且
 * DOM 里同一时刻只挂 3 张（翻页式阅读器），从 HTML 永远正则不出整章。
 *
 * 这里提供的是一个**通用能力**：在页面加载前包住 JSON.parse，把插件提供的
 * 正则命中的内容按出现顺序攒起来。站点知识仍然只有插件里那条正则，
 * 本文件不含任何具体站点信息。
 *
 * 刻意不做的事：不解密、不抠密钥、不伪造指纹、不改 navigator.webdriver。
 * 我们只是看站点自己的代码亲手算出来、并且已经交给它自己渲染的东西 ——
 * 和在 DevTools 里看同一个变量没有区别，站点该拒绝的自动化客户端照样拒绝。
 */

/** 单个字符串至少这么长才值得扫（短字符串里不会有整章图片表，白跑正则） */
const MIN_SCAN_LEN = 64;
/** 单个字符串上限：超了直接跳过，防着一段巨型 JSON 把正则拖死 */
const MAX_SCAN_LEN = 4_000_000;
/** 整页累计扫描量上限。宁可少抓，也不让一个页面把渲染槽占满 */
const TOTAL_SCAN_BYTES = 8_000_000;
/** 单页最多收多少个值 —— 正常一章几十到几百，上万基本是正则写错了 */
const MAX_CAPTURES = 5_000;

/**
 * 生成注入页面的脚本源码。
 *
 * @param {string} pattern 插件提供的正则源码（不含 flags）
 * @returns {string}
 */
export function captureScript(pattern) {
  // 用 JSON.stringify 把用户正则变成字符串字面量嵌进源码：
  // 直接拼进 new RegExp("...") 会让模式里的引号变成语法边界，那是注入。
  const src = JSON.stringify(String(pattern));
  return `(function () {
  var re;
  try { re = new RegExp(${src}, 'gi'); } catch (e) { return; }
  var out = [];
  var seen = Object.create(null);
  var scanned = 0;
  window.__zenoCap = out;
  function scan(text) {
    if (typeof text !== 'string') return;
    if (text.length < ${MIN_SCAN_LEN} || text.length > ${MAX_SCAN_LEN}) return;
    if (scanned > ${TOTAL_SCAN_BYTES} || out.length >= ${MAX_CAPTURES}) return;
    scanned += text.length;
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      var val = m[1] != null ? m[1] : m[0];
      if (val && seen[val] !== 1) {
        seen[val] = 1;
        out.push(val);
        if (out.length >= ${MAX_CAPTURES}) return;
      }
      // 零宽匹配不会自己前进，不手动推进就死循环
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  var parse = JSON.parse;
  JSON.parse = function () {
    var value = parse.apply(this, arguments);
    try { scan(arguments[0]); } catch (e) {}
    return value;
  };
})();`;
}

/** 读回捕获结果。iframe 里的那份不收 —— 正文接口只会请求在主框架 */
export async function readCaptures(page) {
  return page
    .evaluate(() => (Array.isArray(window.__zenoCap) ? window.__zenoCap.slice() : []))
    .catch(() => []);
}
