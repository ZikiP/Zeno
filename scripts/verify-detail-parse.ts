/**
 * 用真实渲染产物验证解析层：拿 baozimh 详情页渲染回来的 HTML，
 * 走一遍 parseChapters，看能不能拿到全部章节 id。
 */
import fs from 'node:fs';
import { parseChapters } from '../src/site/parse';

const html = fs.readFileSync(process.argv[2], 'utf8');
const rules = {
  chapterItem: 'comics-chapters__item',
  chapterIdFrom: 'section_slot=(\\d+)&chapter_slot=(\\d+)',
} as never;
const chapters = parseChapters(html, rules);
console.log('解析出章节数：', chapters.length);
console.log('前 3 条：', JSON.stringify(chapters.slice(0, 3)));
console.log('后 3 条：', JSON.stringify(chapters.slice(-3)));
const dupes = chapters.length - new Set(chapters.map((c) => c.id)).size;
console.log('重复 id：', dupes);
