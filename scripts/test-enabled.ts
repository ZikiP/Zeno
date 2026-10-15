/**
 * 启用集合的读写行为
 *
 * 一个源只有启用/停用两种状态，而这件"看起来没什么好测"的事其实是升级路径上
 * 最容易出错的一环：老版本存的是 `activePluginId`（同时只有一个），新版本是
 * `enabledPluginIds`（逗号拼接）。这里的判断是**老的键不参与**：没写过新键就按
 * 已装的全体启用。照老键只启用一个的话，升级那一刻书架上另一个源的书会凭空少掉，
 * 看着就像功能坏了。
 *
 * 跑的是 src/store/plugins.ts 里那份真实现，只把 localStorage 换成一个 Map。
 */

const mem = new Map<string, string>();
/** 这个套件没有导出，加一行空 export 让它成为模块（顶层 await 需要） */
export {};
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { enabledIdsOf, setPluginEnabled, browseIdOf } = await import('../src/store/plugins.ts');

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};
const eq = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
const reset = () => mem.clear();

const A = 'baozimh';
const B = 'copymanga';
const BOTH = [A, B];

console.log('\n=== 1. 两种键都没写过：装上的都算启用');
reset();
check(eq(enabledIdsOf(BOTH), BOTH), '刚导入第一个插件的机器不该还要去设置里点一下');
reset();
check(eq(enabledIdsOf([]), []), '一个插件都没有时是空集合（不是 null、也不是崩溃）');

console.log('\n=== 2. 老设备升级：装过的源都还在');
reset();
mem.set('activePluginId', B);
check(
  eq(enabledIdsOf(BOTH), BOTH),
  '不照老的 activePluginId 只启用一个 —— 那样升级那一刻书架上另一个源的书会凭空消失',
);
reset();
mem.set('activePluginId', 'uninstalled-site');
check(eq(enabledIdsOf(BOTH), BOTH), '老键指向已卸载的源也一样全启用（这个键根本不参与判断）');

console.log('\n=== 3. 写过 enabledPluginIds 就以它为准');
reset();
mem.set('enabledPluginIds', `${A},${B}`);
mem.set('activePluginId', B);
check(eq(enabledIdsOf(BOTH), [A, B]), '新键存在时旧的 activePluginId 不再参与（否则停用会失效）');
reset();
mem.set('enabledPluginIds', 'ghost,');
check(eq(enabledIdsOf(BOTH), []), '集合里没装过的 id 与空段都被丢掉');
reset();
mem.set('enabledPluginIds', '');
check(
  enabledIdsOf(BOTH).length === 0 && mem.get('activePluginId') === undefined,
  '空串是"全都停用"这个有效状态，不能当成"没写过"而退回默认全启用',
);

console.log('\n=== 4. 开关改一个源：顺序与返回集合');
reset();
let next = setPluginEnabled(A, false, BOTH);
check(eq(next, [B]), `关掉一个只剩另一个（实际 ${JSON.stringify(next)}）`);
next = setPluginEnabled(A, true, BOTH);
check(eq(next, BOTH), '重新打开按安装顺序插回原位，列表不会跳序');
next = setPluginEnabled('ghost', true, BOTH);
check(eq(next, BOTH), '启用一个没装的源不会污染集合');
check(mem.get('enabledPluginIds__at') !== undefined, '写集合时带上 __at 时间戳（同步的 LWW 要用它）');

console.log('\n=== 5. 发现页在看哪个源');
reset();
check(browseIdOf([A, B]) === A, '没记过 → 用启用集合的第一个');
mem.set('browsePluginId', B);
check(browseIdOf([A, B]) === B, '记过而且还启用 → 停在原来那个源');
check(browseIdOf([A]) === A, '记的源被停用了 → 退到还启用的那个，不停在死页上');
check(browseIdOf([]) === null, '全都停用 → null（界面该是空的）');

console.log(fails === 0 ? '\n全部通过 — 启用集合行为正确' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
