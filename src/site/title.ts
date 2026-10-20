/**
 * 源站标题 → 界面上显示的书名。
 *
 * 详情页的 <title> 常把 SEO 尾巴整个塞进来，插件原样存下后书架会变成
 * 「魔都精兵的奴隸-魔都精兵的奴隸漫畫-第188话-連載中-冒險漫画…」。
 * 这里只处理能确认的模式，认不出来就原样返回 —— 猜错书名比截断更糟。
 */
export function displayComicTitle(raw: string, sourceName?: string): string {
  let s = (raw ?? '').trim();
  if (!s) return s;

  /* 源站喜欢在标题前插一个图标（🍘、🌈…）。图标不是书名的一部分 */
  s = s.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '');

  /*
   * 「标题-标题漫畫-第N话-…」：后半段以同一个标题开头，说明这是站点把书名
   * 重复了一遍再拼章节信息。只取前半段。
   */
  const dup = s.match(/^(.{2,80}?)[-–—]\s*(.+)$/);
  if (dup && dup[2].startsWith(dup[1])) s = dup[1];

  /* 「标题 - 拷貝漫畫」：只有尾巴确实是这个源的名字时才去掉 */
  if (sourceName) {
    const tail = new RegExp(`\\s*[-–—|]\\s*${escapeRegExp(sourceName)}\\s*$`, 'i');
    s = s.replace(tail, '');
  }

  return s.trim() || raw.trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
