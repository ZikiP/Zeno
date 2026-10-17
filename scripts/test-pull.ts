/**
 * 上拉蓄力的时间数学
 *
 * 这条要钉的是"1.5 秒左右才接下一章、中途松手退回去"这句话本身。
 * 它在界面上量不到：隐藏标签页不跑帧，真机上要人按住手试，
 * 而攒错 300ms 的体感差别是"要么太容易跳、要么按半天没反应"，
 * 谁都说不清 —— 所以把状态机做成纯函数，拿时间直接摆进去看结果。
 */
import {
  advancePull,
  DECAY_MS,
  PULL_MS,
  RELEASE_PX,
  BOTTOM_PX,
  wheelStillActive,
  WHEEL_HOLD_MS,
} from '../src/pages/reader/pullCharge';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

/** 模拟一串帧：每帧 dt 毫秒，返回攒到最后的状态和"第几帧够了" */
function frames(n: number, dt: number, opts: { active: boolean; landed: boolean; from?: number }) {
  let accMs = opts.from ?? 0;
  for (let i = 0; i < n; i++) {
    const r = advancePull(accMs, dt, opts);
    accMs = r.accMs;
    if (r.done) return { accMs, doneAtFrame: i + 1 };
  }
  return { accMs, doneAtFrame: 0 };
}

console.log('\n=== 1. 按住不放要差不多 1.5 秒 ===');
const hold = frames(200, 16, { active: true, landed: true });
check(hold.doneAtFrame > 0, `按着能攒满（第 ${hold.doneAtFrame} 帧，约 ${hold.doneAtFrame * 16}ms）`);
check(
  Math.abs(hold.doneAtFrame * 16 - PULL_MS) <= 48,
  `用时贴着 ${PULL_MS}ms，实得 ${hold.doneAtFrame * 16}ms（一帧 16ms 的误差以内）`,
);

console.log('\n=== 2. 中途松手要退回去，而且退得干净 ===');
const half = frames(40, 16, { active: true, landed: true }); // 攒了 ~640ms
check(half.doneAtFrame === 0 && half.accMs > 0, `松手前攒到 ${Math.round(half.accMs)}ms，还没满`);
const back = frames(20, 16, { active: false, landed: true, from: half.accMs });
check(back.accMs === 0, `松手后 ${20 * 16}ms 内退到 0（设计行程 ${DECAY_MS}ms）`);
check(
  DECAY_MS > 100 && DECAY_MS < 600,
  `退的时长在"看得见在退"和"别拖太久"之间，实得 ${DECAY_MS}ms`,
);

console.log('\n=== 3. 滚轮没有松手这回事，靠超时 ===');
const t = 10_000;
check(wheelStillActive(t - 200, t), '200ms 前推过一下 → 还算在拉');
check(!wheelStillActive(t - (WHEEL_HOLD_MS + 50), t), `超过 ${WHEEL_HOLD_MS}ms 没动静 → 算停手`);
/*
 * 一格一格慢慢推不该攒满：两次间隔超过窗口，每帧都在退，
 * 于是"顺手滚了两下"永远跳不了章 —— 这就是防误触的那一半。
 */
let slow = 0;
for (let i = 0; i < 40; i++) {
  const active = i % 4 < 2; // 每 64ms 里只有 32ms 在窗口内
  slow = advancePull(slow, 16, { active, landed: true }).accMs;
}
check(slow < 100, `推推停停（间隔超过 ${WHEEL_HOLD_MS}ms）根本攒不起来，只到 ${Math.round(slow)}ms`);

console.log('\n=== 4. 最后一张图没落地：不涨也不退 ===');
const waiting = frames(60, 16, { active: true, landed: false });
check(waiting.doneAtFrame === 0, '按多久都不会跳');
check(waiting.accMs === 0, '也不涨（0ms）—— 图来了才从头攒，不会一落地就立刻跳');
const landedAfter = frames(200, 16, { active: true, landed: true });
check(landedAfter.doneAtFrame > 0, '图落地后继续按着，能正常攒满');

console.log('\n=== 5. 章末的判定窗口别反了 ===');
check(
  BOTTOM_PX > 0 && BOTTOM_PX < RELEASE_PX,
  `到底 ${BOTTOM_PX}px 内算停在章末，滚回 ${RELEASE_PX}px 以外才取消 —— 两个数不能交叉`,
);

console.log(fails ? `\n${fails} 条没过` : '\n全部通过 — 时间数学站得住');
process.exit(fails ? 1 : 0);
