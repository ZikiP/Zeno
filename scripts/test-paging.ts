/**
 * 一屏几张、以及那一屏占多宽
 *
 * 这一档错了不会崩、不会变慢，只会让"翻到下一章时闪一下"回来：
 * 下一章预热时那一页还没挂载，量不到 offsetWidth，只能按模式算 ——
 * 算出来的宽度跟实际显示宽度差一档，增强版的缓存键就对不上，
 * 翻过去拿不到现成的那张，于是先画原图、半秒后被硬换掉。
 *
 * 所以这里钉两件事：
 *   1. 「双页」是**翻页**那一档的选项，滚动模式没有屏，永远一屏一张；
 *   2. 由它换算出来的目标宽度，跟 enhancePage 在页面上量到的 offsetWidth × dpr 同口径。
 */
import { perPageFor, warmTargetWidth, type ReaderMode } from '../src/pages/reader/usePaging';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

/** 手机竖屏：390 CSS × dpr3 = 1170，正好是合成源那种 959 宽原图会被放大的那一档 */
const PHONE = { innerWidth: 390, devicePixelRatio: 3 };
/** 平板横屏双页：844 CSS 一半一屏，dpr2 */
const TABLET = { innerWidth: 844, devicePixelRatio: 2 };

console.log('=== 1. 双页只对分页成立 ===');
check(perPageFor('paged', 'double') === 2, '分页 + 双页 = 一屏两张');
check(perPageFor('paged', 'single') === 1, '分页 + 单页 = 一张');
check(perPageFor('scroll', 'double') === 1, '滚动模式不管开关怎么拨，都是一屏一张');
check(perPageFor('scroll', 'single') === 1, '滚动 + 单页 = 一张');

console.log('\n=== 2. 宽度按屏数分，dpr 乘在最后 ===');
check(warmTargetWidth(1, PHONE) === 1170, `手机单屏 = 整视口 × dpr（${warmTargetWidth(1, PHONE)}）`);
check(warmTargetWidth(2, TABLET) === 844, `平板双屏 = 半视口 × dpr（${warmTargetWidth(2, TABLET)}）`);
check(
  warmTargetWidth(2, TABLET) === Math.floor((TABLET.innerWidth / 2) * TABLET.devicePixelRatio),
  '双屏那一档确实除了一半（不是忘了除）',
);

console.log('\n=== 3. 组合不变量：滚动模式下预热宽度不随「双页」漂 ===');
/*
 * 这一条就是那个 bug 本身。以前 perPage 不分模式，
 * 于是"滚动 + 双页"的用户预热到的是半个视口宽的那张图，
 * 而屏幕上那一页是整宽 —— 键差一档，一张都命中不了。
 */
for (const mode of ['scroll', 'paged'] as ReaderMode[]) {
  for (const pageMode of ['single', 'double'] as const) {
    const w = warmTargetWidth(perPageFor(mode, pageMode), PHONE);
    const expect = mode === 'paged' && pageMode === 'double' ? 585 : 1170;
    check(w === expect, `${mode} + ${pageMode}：预热宽度 ${w}（期望 ${expect}）`);
  }
}

console.log('\n=== 4. dpr 拿不到时按 1 算，不能算出 0 宽的键 ===');
check(warmTargetWidth(1, { innerWidth: 390, devicePixelRatio: 0 }) === 390, 'dpr=0 退到 1，不是退到 0');

console.log('\n' + '='.repeat(56));
if (fails) {
  console.log(`  ${fails} 项失败`);
  process.exit(1);
}
console.log('  全部通过 — 一屏几张与预热宽度的口径一致');
