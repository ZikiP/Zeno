/**
 * 阅读方式与偏好合并
 *
 * 这里钉的是几件"改错了也不报错、只会悄悄丢设置"的事：
 *   1. 旧全局键 readerMode → 新 readerPrefs.mode 的升级兜底；
 *   2. 阅读方式按书一个独立键，A 书改动不能顺手把 B 书盖掉；
 *   3. 每本书的键要能被通用 settings 同步收走，且各自带 __at；
 *   4. mode 不能混进 bookPrefs 的键列表（那样又会变成整行 LWW）。
 *
 * 跑的是 src 里的真实现，只把 localStorage 换成一个可枚举的 Map。
 */

const mem = new Map<string, string>();
/** 这个套件没有导出，加一行空 export 让它成为模块（顶层 await 需要） */
export {};
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  get length() {
    return mem.size;
  },
  key: (i: number) => [...mem.keys()][i] ?? null,
};

const { loadPrefs, savePrefs, pickBook, BOOK_KEYS, DEFAULT_PREFS, isReaderMode } = await import(
  '../src/reader/prefs.ts'
);
const { adoptLegacyBookMode, bookModeKey, loadBookMode, saveBookMode, listBookModeSettings } =
  await import('../src/sync/bookModes.ts');

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};
const reset = () => mem.clear();

const A = 'baozimh/book-a';
const B = 'baozimh/book-b';

console.log('=== 1. 旧全局键迁移，新字段优先 ===');
reset();
check(loadPrefs().mode === 'scroll', '两份都没写过时默认竖向滚动');
reset();
mem.set('readerMode', 'paged');
check(loadPrefs().mode === 'paged', '只有旧 readerMode 时接过来');
reset();
mem.set('readerMode', 'paged');
mem.set('readerPrefs', JSON.stringify({ mode: 'scroll' }));
check(loadPrefs().mode === 'scroll', 'readerPrefs.mode 优先于旧键');
reset();
mem.set('readerMode', 'paged');
mem.set('readerPrefs', JSON.stringify({ mode: 'bogus' }));
check(loadPrefs().mode === 'paged', '新字段是坏值时退回旧键，不让阅读器挑错视图');
reset();
mem.set('readerMode', 'bogus');
mem.set('readerPrefs', JSON.stringify({ mode: 'bogus' }));
check(loadPrefs().mode === 'scroll', '两处都坏时退回默认值');

console.log('\n=== 2. 保存时镜像旧键，过渡期旧客户端还能收到 ===');
reset();
savePrefs({ ...DEFAULT_PREFS, mode: 'paged' });
check(JSON.parse(mem.get('readerPrefs') ?? '{}').mode === 'paged', '新键 readerPrefs.mode 已写入');
check(mem.get('readerMode') === 'paged', '旧键 readerMode 继续镜像一份');
check(loadPrefs().mode === 'paged', '读回来是刚保存的那一档');

console.log('\n=== 3. 阅读方式不混进 bookPrefs 的键列表 ===');
check(!(BOOK_KEYS as readonly string[]).includes('mode'), 'BOOK_KEYS 不含 mode');
const bookPart = pickBook({ mode: 'paged', fit: 'height' });
check(!('mode' in bookPart) && bookPart.fit === 'height', 'pickBook 只带显示项，mode 走独立键');

console.log('\n=== 4. 每本书各自一档，互不覆盖 ===');
reset();
saveBookMode(A, 'paged');
const atA = mem.get(`${bookModeKey(A)}__at`);
saveBookMode(B, 'scroll');
const atB = mem.get(`${bookModeKey(B)}__at`);
check(loadBookMode(A) === 'paged' && loadBookMode(B) === 'scroll', 'A 分页、B 滚动各自独立');
check(!!atA && !!atB, '两本书各自写了 __at');
saveBookMode(A, 'scroll');
check(loadBookMode(A) === 'scroll' && loadBookMode(B) === 'scroll', '改 A 不影响 B');
mem.set(bookModeKey(A), 'bogus');
check(loadBookMode(A) === null, '坏值当作没记过，由全局默认兜底');

console.log('\n=== 4b. bookPrefs 老记录里的 mode 只搬一次 ===');
reset();
check(adoptLegacyBookMode(A, 'paged') === 'paged', '老记录里的 mode 搬进独立键并返回它');
check(loadBookMode(A) === 'paged', '第一屏就能用搬过来的档位');
saveBookMode(A, 'scroll');
check(adoptLegacyBookMode(A, 'paged') === null, '独立键已经有时不覆盖');
check(loadBookMode(A) === 'scroll', '同步来的新选择保持不动');
check(adoptLegacyBookMode(A, 'bogus') === null, '老记录是坏值时忽略');

console.log('\n=== 5. 动态键能进同步，且不把 __at 当模式 ===');
reset();
saveBookMode(A, 'paged');
saveBookMode(B, 'scroll');
mem.set('readerMode', 'paged');
const settings = listBookModeSettings();
check(settings.length === 2, `只导出两本书的模式键（${settings.length}）`);
check(
  settings.every((s) => s.key.startsWith('readerMode:') && (s.value === 'paged' || s.value === 'scroll')),
  '导出项都是有效的按书模式',
);
check(settings.every((s) => Number.isFinite(s.updatedAt) && s.updatedAt > 0), '每项都带可用时间戳');
check(!settings.some((s) => s.key === 'readerMode'), '旧的全局键不混进按书键列表');
mem.set('readerMode:bad-book', 'bogus');
check(listBookModeSettings().length === 2, '坏值不推给服务端');

check(isReaderMode('scroll') && isReaderMode('paged') && !isReaderMode('x'), 'isReaderMode 只认两档');

console.log('\n' + '='.repeat(56));
if (fails) {
  console.log(`  ${fails} 项失败`);
  process.exit(1);
}
console.log('  全部通过 — 阅读方式的归属与同步口径一致');
