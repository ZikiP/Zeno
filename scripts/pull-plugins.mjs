/**
 * 从插件仓库拉最新插件，装进正在跑的服务端
 *
 * 主仓库不附带任何内容源，插件在独立的（私有）仓库里维护。生产机每次部署要能
 * 自己把它们取回来，而不是靠人肉拷 JSON —— 拷漏一次就是"这台怎么没有这个源"。
 *
 * 跑法（要用 tsx，校验器在 src 里，直接引真源码，不在脚本里另写一套规则）：
 *   node --import tsx scripts/pull-plugins.mjs
 *
 * 环境变量：
 *   ZENO_PLUGIN_REPO   owner/name，必填。没配就跳过（框架不该默认指向任何人的仓库）
 *   ZENO_PLUGIN_TOKEN  私有库要。fine-grained PAT，只给那一个仓库的只读权限即可
 *   ZENO_PLUGIN_REF    分支 / tag，默认 main
 *   ZENO_PLUGIN_DIR    插件所在目录，默认 plugins
 *   BASE               服务端地址，默认 http://127.0.0.1:8788
 *   SYNC_TOKEN         服务端设了它就要带 Bearer
 */
import { validatePlugin } from '../src/site/validate';

const REPO = process.env.ZENO_PLUGIN_REPO ?? '';
const TOKEN = process.env.ZENO_PLUGIN_TOKEN ?? '';
const REF = process.env.ZENO_PLUGIN_REF ?? 'main';
const DIR = (process.env.ZENO_PLUGIN_DIR ?? 'plugins').replace(/^\/|\/$/g, '');
const BASE = (process.env.BASE ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');
const SYNC_TOKEN = process.env.SYNC_TOKEN ?? '';

if (!REPO) {
  console.log('没配 ZENO_PLUGIN_REPO，跳过。用法：');
  console.log('  $env:ZENO_PLUGIN_REPO = "你的账号/插件库"; $env:ZENO_PLUGIN_TOKEN = "ghp_…"');
  process.exit(0);
}

const ghHeaders = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'zeno-pull-plugins',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

/** Contents API 的公共头 */
const api = (path) => `https://api.github.com/repos/${REPO}/contents/${path}?ref=${encodeURIComponent(REF)}`;

async function ghGet(url) {
  const r = await fetch(url, { headers: ghHeaders });
  if (r.status === 401 || r.status === 403) {
    throw new Error(`GitHub 拒绝访问（HTTP ${r.status}）—— 私有库要 ZENO_PLUGIN_TOKEN，且 PAT 得能读这个仓库`);
  }
  if (r.status === 404) {
    throw new Error(`找不到 ${url.split('/contents/')[1] ?? url}（404）—— 仓库名、目录或分支对不对？私有库也可能是 token 权限不够`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

/** 列出目录里的 .json 文件名。列表响应里**没有** content 字段，内容要逐个再取。 */
async function listRemotePlugins() {
  const entries = await ghGet(api(DIR));
  if (!Array.isArray(entries)) {
    throw new Error(`${REPO}/${DIR} 不是一个目录（返回的是单个 ${entries?.type ?? '对象'}）`);
  }
  return entries
    .filter((e) => e.type === 'file' && e.name.endsWith('.json'))
    .map((e) => ({ name: e.name, path: e.path }));
}

/** 取单个文件正文。base64 每 60 字符换行，Buffer 会自己忽略空白 */
async function fetchText(path) {
  const j = await ghGet(api(path));
  return Buffer.from(j.content ?? '', 'base64').toString('utf8');
}

/** 服务端现在装着什么 —— 用来判断要不要推，避免每次部署都把 LWW 时间戳刷新一遍 */
async function remoteState() {
  const r = await fetch(`${BASE}/api/sync/pull?since=0&deviceId=pull-plugins`, { headers: syncHeaders() });
  if (!r.ok) throw new Error(`读服务端插件列表失败：HTTP ${r.status}`);
  const j = await r.json();
  const byId = new Map();
  for (const p of j.plugins ?? []) {
    try {
      byId.set(p.id, JSON.parse(p.data));
    } catch {
      /* 库里躺着坏 JSON，当作没有 —— 下面会照常覆盖它 */
    }
  }
  return byId;
}

const syncHeaders = () => ({
  'Content-Type': 'application/json',
  ...(SYNC_TOKEN ? { Authorization: `Bearer ${SYNC_TOKEN}` } : {}),
});

const norm = (o) => JSON.stringify(o);

let files;
try {
  files = await listRemotePlugins();
} catch (e) {
  console.error(`[X] ${e.message}`);
  process.exit(1);
}
console.log(`仓库 ${REPO}/${DIR}@${REF}：${files.length} 个插件文件`);

const installed = await remoteState().catch((e) => {
  console.error(`[X] ${e.message}`);
  console.error('    服务端没在跑？拉插件要经过它的同步接口。');
  process.exit(1);
});
const toPush = [];
const repoIds = new Set();
let same = 0;

for (const f of files) {
  let plugin;
  try {
    plugin = JSON.parse(await fetchText(f.path));
  } catch (e) {
    console.log(`  [SKIP] ${f.name} 取不到或不是合法 JSON：${e.message}`);
    continue;
  }
  const errs = validatePlugin(plugin);
  if (errs.length) {
    console.log(`  [SKIP] ${f.name} 格式校验没过：${errs[0]}`);
    continue;
  }
  const id = plugin.meta.id;
  repoIds.add(id);
  const cur = installed.get(id);
  if (cur && norm(cur) === norm(plugin)) {
    same++;
    continue;
  }
  toPush.push({ id, origin: 'imported', data: norm(plugin), updatedAt: Date.now() });
  console.log(`  [${cur ? '更新' : '新增'}] ${plugin.meta.name}（${id}）v${plugin.meta.version ?? '?'}`);
}

if (!toPush.length) {
  console.log(`\n服务端已与仓库一致（${same} 个未变）`);
  const leftover = [...installed.keys()].filter((id) => !repoIds.has(id));
  if (leftover.length) console.log(`仓库里没有、保持原样的插件：${leftover.join(', ')}`);
  process.exit(0);
}

const r = await fetch(`${BASE}/api/sync/push`, {
  method: 'POST',
  headers: syncHeaders(),
  body: JSON.stringify({ deviceId: 'pull-plugins', seq: 0, plugins: toPush }),
});
const body = await r.json().catch(() => ({}));
if (!r.ok || !body.ok) {
  console.error(`[X] 推送失败：HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  process.exit(1);
}
console.log(`\n已装 ${body.applied?.plugins ?? toPush.length} 个（另有 ${same} 个未变）`);
console.log(`抓取白名单：${(body.allowedHosts ?? []).join(', ') || '(空)'}`);
console.log('各端下次同步就会拿到，不用重启服务。');
