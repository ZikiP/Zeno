/**
 * HTTP 响应小工具
 *
 * 从 index.mjs 抽出来是因为代理和同步 API 都要用同一套：
 * 各自写一份 JSON 响应头，早晚会出现「某个端点忘了 no-store」这种不一致。
 */
import { timingSafeEqual } from 'node:crypto';

export function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(s);
}

/**
 * 读请求体并解析 JSON。
 *
 * 超过上限时**不能**直接 throw：请求体没读完就回响应，Node 会重置连接，
 * 复用同一 socket 的下一个请求就拿到 ECONNRESET（实测踩过：
 * 413 用例自己把后面的用例打挂了）。
 * 所以继续把剩下的排空、但不再缓存，读完才报错。
 */
export async function readBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(c);
  }
  if (tooLarge) {
    throw Object.assign(new Error('payload too large'), { status: 413 });
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 造一个 auth(req)。没设令牌时恒为 true。
 *
 * 比较用定长 + timingSafeEqual：用 === 比令牌的耗时会随前缀相同的长度增长，
 * 理论上能被计时攻击逐字节猜。本机自用威胁模型下几乎不可利用，
 * 但正确写法并不更贵。
 */
export function makeAuth(token) {
  if (!token) return () => true;
  const expected = Buffer.from(`Bearer ${token}`);
  return (req) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
}
