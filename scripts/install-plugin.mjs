/**
 * 把本地插件文件装进服务端（走同步接口）
 * 用途：手机还没配好之前，先在电脑上把插件灌进服务端，
 *      这样手机一打开就有内容可看，两边也能立刻对上。
 */
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const FILE = process.argv[2] || 'baozimanga-plugin.json';

const plugin = JSON.parse(readFileSync(FILE, 'utf8'));
console.log(`读取插件: ${plugin.meta.name} (${plugin.meta.id})`);

const r = await fetch(BASE + '/api/sync/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deviceId: 'setup-cli',
    seq: 0,
    plugins: [
      {
        id: plugin.meta.id,
        origin: 'imported',
        data: JSON.stringify(plugin),
        updatedAt: Date.now(),
      },
    ],
  }),
});

const body = await r.json();
console.log('推送结果:', JSON.stringify(body, null, 2));

if (!r.ok || !body.ok) {
  console.error('安装失败');
  process.exit(1);
}

console.log('\n现在手机打开应该就能看到内容了。');
