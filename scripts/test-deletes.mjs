/**
 * 删除传播验证
 *
 * 同步是「推全量 → 拉全量」，upsert 只能增不能删。没有墓碑的话，
 * A 设备删掉的东西会被 B 设备下一次 push 原样推回来 —— 用户看到的就是删不掉。
 * 这里验的是服务端这一侧的三条性质：
 *   1. 删除能让主表那行真的消失
 *   2. 别的设备把旧数据再推一次，不能把已删的行复活
 *   3. 但比墓碑新的写入要能落库（用户真的又重新加了）
 */
const BASE = process.env.BASE;
if (!BASE) {
  console.error('\n缺少 BASE。请用 `npm test` —— 它会为每个套件起独立端口和独立临时库。');
  process.exit(2);
}

let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!ok) fails++;
};

const T = 1_700_000_000_000; // 固定基准，重跑结果一致
const P = {
  id: 'del-test',
  origin: 'imported',
  data: JSON.stringify({
    format: 'zeno-plugin@1',
    meta: { id: 'del-test', name: '删除测试源', icon: '🗑' },
    entry: 'https://del.example.com',
    chapterHost: 'https://del.example.com',
    urls: { search: '/s?q={q}', detail: '/c/{slug}', chapter: '/c/{slug}/{id}.html' },
    parse: { card: '<div class="c', slugFrom: 'href="/c/([^"?]+)"', title: { attr: 'title' } },
    imageHosts: ['del.example.com'],
    headers: {},
  }),
};
const row = { pluginId: P.id, slug: 'a/b', title: '标题含斜杠', cover: '', addedAt: T, updatedAt: T };
const bookmark = { key: `${P.id}/a/b/ch1/3`, pluginId: P.id, slug: 'a/b', chapterId: 'ch1', page: 3, percent: 10, createdAt: T, updatedAt: T };
const position = { pluginId: P.id, slug: 'a/b', chapterId: 'ch1', percent: 40, updatedAt: T };

async function push(body) {
  const r = await fetch(`${BASE}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}
const pull = () => fetch(`${BASE}/api/sync/pull?since=0&deviceId=del-test`).then((r) => r.json());

console.log('\n=== 1. 先写入一批数据 ===');
const first = await push({
  deviceId: 'dev-a',
  seq: 0,
  plugins: [P],
  shelf: [row],
  bookmarks: [bookmark],
  positions: [position],
});
check(first.applied?.plugins === 1, `插件写入 ${first.applied?.plugins}`);
check(first.applied?.shelf === 1, `书架写入 ${first.applied?.shelf}`);

let snap = await pull();
check(snap.shelf.length === 1, '书架可拉回');
check(snap.positions.length === 1, '进度可拉回');

console.log('\n=== 2. 打墓碑，主表那行要真的消失 ===');
// slug 里带 '/'，正好检验服务端是按「首段/尾段」而不是 split('/') 的段数定位主键的
const deletes = [
  { kind: 'shelf', id: `${P.id}/a/b`, deletedAt: T + 1000 },
  { kind: 'bookmark', id: bookmark.key, deletedAt: T + 1000 },
  { kind: 'position', id: `${P.id}/a/b/ch1`, deletedAt: T + 1000 },
];
await push({ deviceId: 'dev-a', seq: 0, deletes });
snap = await pull();
check(snap.shelf.length === 0, `书架已删（剩 ${snap.shelf.length}）`);
check(snap.bookmarks.length === 0, `书签已删（剩 ${snap.bookmarks.length}）`);
check(snap.positions.length === 0, `进度已删（剩 ${snap.positions.length}）`);
check(snap.deletes?.length === 3, `墓碑留存 ${snap.deletes?.length} 条`);

console.log('\n=== 3. 另一台设备把旧数据再推一次 —— 不能复活 ===');
// dev-b 还停在删除之前，它 push 的 updated_at 就是原来那个 T
await push({ deviceId: 'dev-b', seq: 0, shelf: [row], bookmarks: [bookmark], positions: [position] });
snap = await pull();
check(snap.shelf.length === 0, '书架没有被旧数据复活');
check(snap.bookmarks.length === 0, '书签没有被旧数据复活');
check(snap.positions.length === 0, '进度没有被旧数据复活');

console.log('\n=== 4. 比墓碑新的写入要正常落库（用户又加回去了）===');
await push({
  deviceId: 'dev-b',
  seq: 0,
  shelf: [{ ...row, updatedAt: T + 2000 }],
  positions: [{ ...position, updatedAt: T + 2000 }],
});
snap = await pull();
check(snap.shelf.length === 1, '重新添加的书架条目保住了');
check(snap.positions.length === 1, '重新产生的进度保住了');

console.log('\n=== 5. 删除时间戳本身也参与 LWW ===');
// 一条更旧的墓碑不该把刚加回来的数据删掉
await push({ deviceId: 'dev-b', seq: 0, deletes: [{ kind: 'shelf', id: `${P.id}/a/b`, deletedAt: T + 500 }] });
snap = await pull();
check(snap.shelf.length === 1, '旧墓碑不会误删新数据');

console.log('\n=== 6. 同一批里「重新添加 + 旧墓碑」—— 添加要赢 ===');
// 这是真实形态：设备本地既留着那条墓碑，又有用户刚加回来的记录，
// 一次 push 全推上去。服务端是"先增后删"的顺序，不看数据时间戳就会把前者抹掉。
const back = { ...row, addedAt: T + 3000, updatedAt: T + 3000 };
await push({
  deviceId: 'dev-b',
  seq: 0,
  shelf: [back],
  deletes: [{ kind: 'shelf', id: `${P.id}/a/b`, deletedAt: T + 2500 }],
});
snap = await pull();
check(snap.shelf.length === 1, '同批里比墓碑新的添加没有被删掉');
check(snap.shelf[0]?.updated_at === T + 3000, `落的是新那条（${snap.shelf[0]?.updated_at}）`);

console.log('\n=== 7. 删插件要连它名下的数据一起消失 ===');
await push({ deviceId: 'dev-b', seq: 0, plugins: [{ ...P, updatedAt: T + 4000 }] });
snap = await pull();
check(snap.plugins.length === 1, '插件在');
const delPlugin = await fetch(`${BASE}/api/sync/forget-plugin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: P.id, deviceId: 'dev-b' }),
});
check((await delPlugin.json()).removed === true, 'forget-plugin 报告删除成功');
snap = await pull();
check(snap.plugins.length === 0, '插件已删');
check(snap.shelf.length === 0, `书架跟着清了（剩 ${snap.shelf.length}）`);
check(snap.positions.length === 0, `进度跟着清了（剩 ${snap.positions.length}）`);
check(snap.deletes.some((x) => x.kind === 'plugin' && x.id === P.id), '留下了插件墓碑');

console.log('\n=== 8. 插件墓碑要能挡住旧设备把插件推回来 ===');
await push({ deviceId: 'dev-old', seq: 0, plugins: [{ ...P, updatedAt: T }] });
snap = await pull();
check(snap.plugins.length === 0, '旧数据没有复活插件');

console.log('\n=== 9. 旧设备把它名下的行推回来 —— 不能复活成孤儿行 ===');
// forget-plugin 在服务端已经级联删过，但还没同步过的设备手里仍留着这些行。
// 各 upsert 原本只查自己 kind 的墓碑（shelf/<id>/<slug>），插件那一层没人问，
// 于是它们会重新插进主表，指向一个已经不存在的插件。
// 时间戳刻意取 T+3000：比第 2 节那些行墓碑新（同 kind 的拦不住），
// 但比 forget-plugin 打的插件墓碑（墙上时钟）旧。
await push({
  deviceId: 'dev-old',
  seq: 0,
  shelf: [{ ...row, updatedAt: T + 3000 }],
  positions: [{ ...position, updatedAt: T + 3000 }],
  bookmarks: [{ ...bookmark, updatedAt: T + 3000 }],
});
snap = await pull();
check(snap.shelf.length === 0, `书架没被推回来（剩 ${snap.shelf.length}）`);
check(snap.positions.length === 0, `进度没被推回来（剩 ${snap.positions.length}）`);
check(snap.bookmarks.length === 0, `书签没被推回来（剩 ${snap.bookmarks.length}）`);

console.log('\n=== 10. 重新安装同一个插件（更新的写入）应当被接受 ===');
// 时间戳必须真的比墓碑新。forget-plugin 用的是墙上时钟，这里继续用固定基准 T
// 就只是在验证脚本自己的假设，所以改用真实时钟 + 偏移。
await push({ deviceId: 'dev-b', seq: 0, plugins: [{ ...P, updatedAt: Date.now() + 60_000 }] });
snap = await pull();
check(snap.plugins.length === 1, '重新安装的插件没被墓碑挡住');

console.log('\n' + '='.repeat(52));
console.log(fails === 0 ? '  全部通过 — 删除传播正确' : `  ${fails} 项失败`);
console.log('='.repeat(52));
process.exit(fails === 0 ? 0 : 1);
