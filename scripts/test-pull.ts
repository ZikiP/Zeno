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
  PULL_MAX_MS,
  PULL_MIN_MS,
  PULL_STEP_MS,
  RELEASE_PX,
  BOTTOM_PX,
  safePullMs,
  wheelStillActive,
  WHEEL_HOLD_MS,
} from '../src/pages/reader/pullCharge';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

/** 模拟一串帧：每帧 dt 毫秒，返回攒到最后的状态和"第几帧够了" */
function frames(
  n: number,
  dt: number,
  opts: { active: boolean; landed: boolean; from?: number; pullMs?: number },
) {
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

console.log('\n=== 5. 时长可以在设置里调 ===');
const fast = frames(200, 16, { active: true, landed: true, pullMs: 800 });
check(fast.doneAtFrame === 50, `调成 0.8 秒就 0.8 秒满（第 ${fast.doneAtFrame} 帧，${fast.doneAtFrame * 16}ms）`);
/*
 * 人把滑条拖短了，已经攒下的那一截不该作废：接着攒到新的门槛就该跳。
 * 这条测的是"要攒多少"是每帧现读的，不是启动时抄一份。
 */
let mid = 0;
for (let i = 0; i < 60; i++) mid = advancePull(mid, 16, { active: true, landed: true, pullMs: 1500 }).accMs;
const shortened = frames(40, 16, { active: true, landed: true, from: mid, pullMs: 1200 });
check(
  shortened.doneAtFrame > 0 && shortened.doneAtFrame <= 40,
  `先按默认攒了 ${Math.round(mid)}ms，改短到 1.2 秒后再 ${shortened.doneAtFrame * 16}ms 就满了（不清零）`,
);
const long3 = frames(150, 16, { active: true, landed: true, pullMs: 3000 });
check(long3.doneAtFrame === 0, `默认时长下按 2.4 秒还不够（3 秒档没被 1.5 秒顶掉）`);
/*
 * 存下来的值可能是老版本、手改、或者别的设备写来的：0、负数、NaN、超出滑条范围
 * 都不能把状态机带坏 —— 除出个 0 会让每次轻碰都算"攒满"。
 */
check(safePullMs(0) === 1500, `0 兜回默认（实得 ${safePullMs(0)}）`);
check(safePullMs(-5) === 1500, `负数兜回默认（实得 ${safePullMs(-5)}）`);
check(safePullMs('abc') === 1500, `NaN 兜回默认（实得 ${safePullMs('abc')}）`);
check(safePullMs(1) === PULL_MIN_MS, `小到 1ms 也提到下限 ${PULL_MIN_MS}`);
check(safePullMs(999999) === PULL_MAX_MS, `大到无限也压到上限 ${PULL_MAX_MS}`);
check(safePullMs(1234) === 1200, `对齐到 ${PULL_STEP_MS}ms 一档（1234 → ${safePullMs(1234)}）`);
check(advancePull(0, 50, { active: true, landed: true, pullMs: 0 }).done === false, '状态机自己也不信外来的 0');

console.log('\n=== 6. 章末的判定窗口别反了 ===');
check(
  BOTTOM_PX > 0 && BOTTOM_PX < RELEASE_PX,
  `到底 ${BOTTOM_PX}px 内算停在章末，滚回 ${RELEASE_PX}px 以外才取消 —— 两个数不能交叉`,
);

console.log(fails ? `\n${fails} 条没过` : '\n全部通过 — 时间数学站得住');
process.exit(fails ? 1 : 0);
