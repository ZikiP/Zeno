import type { Plugin } from './types';

/**
 * URL 模板的规则
 *
 * 从 validate.ts 抽出来：一份占位符表同时被三处用 —— 导入校验、引擎拼地址
 * 前的对照、还有"模板里写了个不认识的占位符"这类报错文案。它跟"这份 JSON
 * 是不是合法插件"不是一回事，跟 validate.ts 里其余规则的改动原因也不同。
 */

/**
 * 每种 URL 模板能用的占位符。
 *
 * 这是唯一一份定义 —— fillTemplate 的调用方（engine.ts）和导入校验都从这里取，
 * 不会出现在「引擎多支持了一个变量但校验还当它是错的」那种漂移。
 */
export const URL_VARS: Record<keyof Plugin['urls'], string[]> = {
  search: ['q'],
  classify: ['type', 'region', 'state'],
  detail: ['slug'],
  chapter: ['slug', 'id'],
};

/**
 * 检查一个 URL 模板。
 *
 * 为什么值得单独校验：fillTemplate 对认不出的占位符是**替换成空串**的。
 * 于是把 {slug} 写成 {slugg}、或者 detail 里干脆没有 {slug}，
 * 插件照样导得进来，但每一本漫画都会打开同一个页面 ——
 * 看上去像站点坏了，实际是配置里的一个打字错误。
 */
export function validateTemplate(kind: keyof Plugin['urls'], tpl: string, errs: string[]) {
  const used = [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const allowed = URL_VARS[kind];

  for (const v of used) {
    if (!allowed.includes(v)) {
      errs.push(
        `urls.${kind} 里有不认识的占位符 {${v}}，可用的是 ${allowed.map((a) => `{${a}}`).join(' ')}`,
      );
    }
  }

  /*
   * detail 必须靠 {slug} 定位到具体漫画；chapter 必须靠 {id} 定位到具体章节。
   * 少了这些，所有请求都会打到同一个 URL 上。
   * {slug} 在 chapter 里是可选的 —— 有些站的章节地址只有 id。
   * classify 全部可选（有的站的分类页参数是固定写法）。
   */
  const required = kind === 'detail' ? ['slug'] : kind === 'chapter' ? ['id'] : [];
  for (const v of required) {
    if (!used.includes(v)) errs.push(`urls.${kind} 必须包含 {${v}}，否则每本书都会取到同一个地址`);
  }
}
