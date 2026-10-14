/**
 * 静态文件服务
 *
 * 从内存构建产物里取文件，带 SPA 回退（未知的非 API 路径都返回 index.html），
 * 这样前端可以用 History 路由直接访问 /comic/xxx。
 */
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

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

/**
 * 发一个文件。
 *
 * 缓存策略：
 *   带 hash 的静态资源（/assets/*）→ immutable，一年
 *   index.html / sw.js → 不缓存，否则用户拿不到新版本
 */
export function sendFile(res, file, { immutable = false } = {}) {
  const ext = extname(file).toLowerCase();
  const isEntry = ext === '.html' || file.endsWith('sw.js');

  res.writeHead(200, {
    'Content-Type': contentType(file),
    'Cache-Control': isEntry
      ? 'no-cache'
      : immutable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
  });
  createReadStream(file).pipe(res);
}

/**
 * 判断是不是带 hash 的构建产物。
 * vite 默认输出到 assets/xxx-[hash].js
 */
export function isHashedAsset(pathname) {
  return /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(js|css|png|svg|woff2)$/.test(pathname);
}
