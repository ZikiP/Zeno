/**
 * 本地合成图源 + 最小后端，专门用来量「画面增强换图那一下」的时机
 *
 * 为什么不用真站点量：外网一慢，"下载原图"和"Worker 重采样"两段时间就糊在一起，
 * 分不清增强版晚多久、也复现不了"同一张图第二次是缓存命中"。
 * 这里把源图摊在 127.0.0.1 上（几毫秒到手），只剩重采样那半秒是变量。
 *
 * 起法（两个窗口，或一条命令里都带 & 后台跑）：
 *   node scripts/fake-enhance-source.mjs          # 8911：页面 + 图
 *   PORT=8912 ALLOW_PRIVATE_HOSTS=1 ALLOWED_HOSTS=127.0.0.1 \
 *     DB_PATH=%TEMP%\zeno-fake.db node server/index.mjs
 * 然后 node scripts/verify-enhance-local.mjs
 */
/** 解析层的图片正则只认 .jpg/.jpeg/.png/.webp，所以这里出 PNG 而不是 BMP */
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

const PORT = Number(process.env.FAKE_PORT || 8911);
const PAGES = Number(process.env.FAKE_PAGES || 6);
const W = 959;
const H = 1300;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h, rgb) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 细线 + 硬边缘：放大时双线性会糊，非锐化能救回来，肉眼也最好认 */
function pageImage(i) {
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      let v = (Math.floor(y / 90) + i) % 2 ? 235 : 210;
      if (x % 7 < 1) v = 250;
      if ((y - i * 13) % 91 < 2) v = 30;
      rgb[o] = v;
      rgb[o + 1] = v;
      rgb[o + 2] = v;
      if (x > 250 && x < 260 && y > 300 && y < 900) {
        rgb[o] = 220;
        rgb[o + 1] = 40;
        rgb[o + 2] = 40;
      }
    }
  }
  return png(W, H, rgb);
}

/**
 * 详情页：4 张 `<div class="book">` 卡（给 parse.card 切）+ 3 条章节 `<a>`（给 chapterItem）。
 * 两套 class 刻意不重叠 —— card 的切分点若出现在章节行上，会切出一堆假漫画。
 */
const detailHtml = () =>
  `<!doctype html><meta charset="utf-8"><div class="detail">` +
  Array.from({ length: 4 }, (_, i) => `<div class="book" title="合成漫画${i}" data-slug="demo${i}">第${i}本</div>`).join('') +
  `<div class="toc">` +
  Array.from({ length: 3 }, (_, i) => `<a class="chap" href="/chapter?c=${i}">第${i + 1}章</a>`).join('') +
  `</div>` +
  `<img title="封面" src="http://127.0.0.1:${PORT}/img/0.png">` +
  `<div class="desc">本地合成页图，用来量画面增强换图的时机。</div></div>`;

const chapterHtml = (base) =>
  `<!doctype html><meta charset="utf-8"><div class="pages">` +
  Array.from({ length: PAGES }, (_, i) => `<img class="reader-img" src="${base}/img/${i}.png">`).join('') +
  `</div>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/detail') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(detailHtml());
    return;
  }
  if (url.pathname === '/chapter') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(chapterHtml(`http://127.0.0.1:${PORT}`));
    return;
  }
  const m = url.pathname.match(/^\/img\/(\d+)\.png$/);
  if (m) {
    const buf = pageImage(Number(m[1]));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
    res.end(buf);
    return;
  }
  res.writeHead(404).end('nope');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake] 合成源已就绪 http://127.0.0.1:${PORT} （${PAGES} 页 / ${W}x${H} BMP）`);
});
