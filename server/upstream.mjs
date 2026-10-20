/**
 * 取上游并把响应转给客户端
 *
 * 从 proxy.mjs 拆出来：代理该管的是"放不放行"（白名单、地址策略、并发闸），
 * 这块管的是"放行之后怎么取、怎么转"。两件事的改动原因完全不同，
 * 混在一起时 proxy.mjs 早早就过了工具文件的行数上限。
 *
 * 三道闸里的**逐跳**校验在这里：重定向必须自己跟、自己校验。
 * 交给 fetch 的 redirect:'follow' 等于开后门 —— 白名单域名只要回一个
 * 302 → http://127.0.0.1:8788/ 就绕过了域名白名单和地址策略两道闸。
 * 反过来直接透传 3xx 也不行：客户端会自己去跟，撞 CORS 且绕过代理。
 */
import { Readable } from 'node:stream';
import { assertPublicTarget } from './ssrf.mjs';
import { hostAllowed } from './allowlist.mjs';
import { json } from './respond.mjs';
import { cacheableAsImage, collector } from './cache-store.mjs';
import { htmlCollector } from './html-cache.mjs';
import { IMG_CACHE_CONTROL } from './cache.mjs';

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
/** 放行解析到内网/回环的目标。只给本地测试用，生产不该开 */
const ALLOW_PRIVATE_HOSTS = process.env.ALLOW_PRIVATE_HOSTS === '1';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 20_000);
const MAX_HOPS = 5;

/**
 * 取 target（逐跳跟随重定向并校验），把结果写给 res。
 *
 * @param {{
 *   req: import('node:http').IncomingMessage,
 *   res: import('node:http').ServerResponse,
 *   target: URL,
 *   pluginHeaders?: Record<string, string>,
 *   cacheKey: string,
 *   cors: Record<string, string>,
 *   release: () => void,
 * }} args
 */
export async function pipeUpstream({ req, res, target, pluginHeaders = {}, cacheKey, htmlKey = null, cors, release }) {
  /**
   * 站点声明的头优先。这不是可有可无的装饰：实测拷貝漫畫只给桌面
   * UA 返回服务端渲染的列表，手机 UA 一律 302 到 JS 壳 —— 固定发 MOBILE_UA
   * 的话，那个站本来 1 秒就能拿到的页面必须花 3 秒去渲染，而列表页压根渲染不出卡片。
   */
  const fwdHeaders = {
    'User-Agent': pluginHeaders['user-agent'] ?? MOBILE_UA,
    Accept: pluginHeaders.accept ?? req.headers.accept ?? '*/*',
    'Accept-Language': pluginHeaders['accept-language'] ?? 'zh-TW,zh;q=0.9',
    ...(pluginHeaders.referer ? { Referer: pluginHeaders.referer } : {}),
  };

  let current = target;
  let upstream;
  let lastErr;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const again = await assertPublicTarget(current, { allowPrivate: ALLOW_PRIVATE_HOSTS });
    if (!again.ok) {
      return json(res, 403, {
        error: 'blocked address',
        host: current.hostname,
        reason: `重定向目标被拒：${again.reason}`,
      });
    }
    const hopHost = current.hostname.toLowerCase();
    if (!hostAllowed(hopHost)) {
      return json(res, 403, {
        error: 'host not allowed',
        host: hopHost,
        hint: '上游把请求重定向到了白名单外的域名，已拒绝跟随。',
      });
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        upstream = await fetch(current.toString(), {
          headers: fwdHeaders,
          redirect: 'manual',
          /*
           * 必须有超时。之前没有，一个挂死的上游连接会永久占着
           * MAX_CONCURRENT 几分之一的名额 —— 几个之后整个代理就"看起来卡死"，
           * 而且没有任何报错可看。
           */
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        if (upstream.ok) break;
        /*
         * 4xx 不重试：那是"这个地址就是没有"，重试只会把失败拖成三倍久 ——
         * 章节翻页循环正是靠 404 收尾的，拖慢它等于拖慢每一章的结尾。
         */
        if (upstream.status < 500) break;
        /*
         * 带尺寸参数的封面拿不到，就地把地址换成去掉参数的原图，再走剩下的重试。
         *
         * coverUrl 一律给封面追加 ?w=&h=&q= 让 CDN 出小图，省的是每屏几十张图的流量。
         * 但不是每个路径都吃这套：实测某站的封面占位图带参数时挂 11 秒回 503，
         * 不带参数 0.7 秒 200 —— 一本书就能把整屏详情点成"加载失败"。
         *
         * 必须在**第一次 5xx 之后立刻**换：放到三轮重试之后再换，最坏要
         * 11s×3 才走到兜底，比不修还难受。客户端地址没变，缓存键也就没变。
         */
        const bare = withoutSizeParams(current);
        if (bare) {
          console.warn(`[zeno] 带尺寸参数取不到（${upstream.status}），改用原图：${bare.hostname}`);
          current = bare;
        }
        lastErr = new Error(`HTTP ${upstream.status}`);
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
    if (!upstream) throw lastErr ?? new Error('upstream unavailable');

    const loc = upstream.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(upstream.status) && loc) {
      try {
        current = new URL(loc, current);
      } catch {
        break; // 非法 Location，就把 3xx 原样回给客户端
      }
      upstream = undefined; // 强制下一跳重新取
      continue;
    }
    break;
  }
  if (!upstream) throw lastErr ?? new Error('重定向次数过多');

  const headers = { ...cors, 'Cache-Control': 'public, max-age=600' };
  const ct = upstream.headers.get('content-type');
  if (ct) headers['Content-Type'] = ct;
  // 图片给一天（本地还有盘上的副本兜着），HTML 保持十分钟：章节列表放一天，用户会以为上游没更新
  if (cacheableAsImage(ct, cacheKey)) headers['Cache-Control'] = IMG_CACHE_CONTROL;

  res.writeHead(upstream.status, headers);
  if (!upstream.body || req.method === 'HEAD') {
    res.end();
    return;
  }

  /*
   * 流式转发必须挂 error 监听。
   * CDN 中途断连（UND_ERR_SOCKET）时 pipe 会抛 error，
   * Node 默认对 Readable 的 error 做 throw，没监听就直接终止进程。
   * 实测踩过：代理跑着跑着整个消失，所有请求变 502。
   */
  const src = Readable.fromWeb(upstream.body);
  /*
   * 顺手攒一份进磁盘缓存。攒在内存里而不是同时写文件：
   * 双写要自己管两个下游的背压，谁慢都会饿着另一个，出错时还容易只清掉一半。
   * 单张上限 8MB、并发 8，最坏占 64MB，换掉的是那一整类 bug。
   * 客户端中途断开时 'end' 不会触发，于是半张图不会被存进去。
   */
  const sink = upstream.ok && cacheableAsImage(ct, cacheKey) ? collector(cacheKey, ct) : null;
  const htmlSink = upstream.ok && htmlKey ? htmlCollector(htmlKey, ct) : null;
  if (sink || htmlSink) {
    src.on('data', (c) => {
      sink?.push(c);
      htmlSink?.push(c);
    });
    src.on('end', () => {
      void sink?.commit();
      htmlSink?.commit();
    });
  }
  src.on('error', (err) => {
    console.warn(`[zeno] upstream aborted: ${err.message}`);
    if (!res.headersSent) res.writeHead(502).end('upstream aborted');
    else res.end();
    release();
  });
  res.on('close', () => {
    if (!res.writableEnded) src.destroy();
  });
  res.on('error', () => src.destroy());
  src.pipe(res);
}

/** 去掉 coverUrl 追加的尺寸参数（w/h/q）。没有可去的返回 null，调用方就不白跑一趟 */
function withoutSizeParams(url) {
  const u = new URL(url.toString());
  let changed = false;
  for (const k of ['w', 'h', 'q']) {
    if (u.searchParams.has(k)) {
      u.searchParams.delete(k);
      changed = true;
    }
  }
  return changed ? u : null;
}
