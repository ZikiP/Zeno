/**
 * 解析会用到的纯文本工具
 *
 * 单独一个文件是因为它们不属于"请求层"（fetch.ts）也不属于"解析规则"
 * （parse.ts），两边都要用：把 HTML 片段变成能读的纯文本、把插件里填的
 * 选择器变成安全的正则片段。
 */

/** HTML 实体解码 —— AMP 之类会把 / 编码成 &#x2F;，不解码就取不到 URL */
export function decodeEntities(s: string): string {
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

/** 去掉标签、压缩空白。用于把富文本简介变成纯文本 */
export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 转义正则元字符，让插件里填的选择器能安全进 RegExp */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
