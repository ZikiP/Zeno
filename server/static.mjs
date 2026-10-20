/**
 * 静态文件服务
 *
 * 从内存构建产物里取文件，带 SPA 回退（未知的非 API 路径都返回 index.html），
 * 这样前端可以用 History 路由直接访问 /comic/xxx。
 */
import { createReadStream, statSync, existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * 把 URL 路径映射到 dist 里的文件。
 * 返回 null 表示没找到（交给调用方回退到 index.html）。
 */
export function resolveStatic(distDir, pathname) {
  // 去掉前导斜并规范化，阻断 ../ 穿越
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const target = resolve(join(distDir, rel));

  // 必须落在 dist 内
  if (!target.startsWith(resolve(distDir) + sep) && target !== resolve(distDir)) {
    return null;
  }

  if (existsSync(target)) {
    const st = statSync(target);
    if (st.isDirectory()) {
      const idx = join(target, 'index.html');
      return existsSync(idx) ? idx : null;
    }
    return target;
  }
  return null;
}

export function contentType(file) {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** 值得压的文本类型。图片/字体本来就压过了，再压是白花 CPU */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg']);
/** 小于这个数压了也省不了几个字节，还多一层头 */
const GZIP_MIN_BYTES = 1024;

/**
 * gzip 结果按文件缓存。
 *
 * 这些文件带 hash、内容不会变，所以缓存永远不会脏；用 mtime + size 兜底，
 * 本地改 dist 调试也不会拿到旧字节。key 是绝对路径，量很小。
 */
const gzipCache = new Map();

function gzipBytes(file, st) {
  const hit = gzipCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.bytes;

  const bytes = gzipSync(readFileSync(file), { level: 6 });
  if (gzipCache.size >= 64) gzipCache.delete(gzipCache.keys().next().value);
  gzipCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, bytes });
  return bytes;
}

function acceptsGzip(req) {
  return /\bgzip\b/i.test(req.headers['accept-encoding'] ?? '');
}

/**
 * 发一个文件。
 *
 * 缓存策略：
 *   带 hash 的静态资源（/assets/*）→ immutable，一年
 *   index.html / sw.js → 不缓存，否则用户拿不到新版本
 *
 * 文本资源按 Accept-Encoding 协商 gzip：这个服务是直接写 HTTP 的，
 * 前面没有 nginx 代压 —— 之前 403 KB 的 JS 和 47 KB 的 CSS 是原样发出去的。
 * HEAD 只回头不回体，别把整个文件再读一遍。
 */
export function sendFile(req, res, file, { immutable = false } = {}) {
  const ext = extname(file).toLowerCase();
  const isEntry = ext === '.html' || file.endsWith('sw.js');
  const st = statSync(file);

  const headers = {
    'Content-Type': contentType(file),
    'Cache-Control': isEntry
      ? 'no-cache'
      : immutable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
  };

  let gz = null;
  if (COMPRESSIBLE.has(ext) && st.size >= GZIP_MIN_BYTES) {
    headers.Vary = 'Accept-Encoding';
    if (acceptsGzip(req)) {
      gz = gzipBytes(file, st);
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = gz.length;
    }
  }
  if (gz) {
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(gz);
    return;
  }

  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}

/**
 * 判断是不是带 hash 的构建产物。
 * vite 默认输出到 assets/xxx-[hash].js
 */
export function isHashedAsset(pathname) {
  return /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(js|css|png|svg|woff2)$/.test(pathname);
}
