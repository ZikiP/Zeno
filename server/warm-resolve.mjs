/**
 * 服务端解一章的图片地址表
 *
 * 追漫要"没人开页面也照追"，就得自己拿到每章的图片地址。这一份是
 * src/site/engine.ts 的 getChapter 的第二份实现，**故意的**，跟 listChapters
 * 同一条路：解析层跑在浏览器包里，服务端不为了一个函数去引前端构建物。
 * 一致性由 scripts/test-warm.mjs 拿同一份假 HTML 比两边结果钉住。
 *
 * 回的一律是**上游地址**，不包 /api/proxy：盘上的键是上游地址的 sha256，
 * 存代理形态的话淘汰时算出来的键跟账本对不上，那张永远删不掉。
 */
import { captureFor, escapeRe, fetchPage, fill, modeFor } from './plugin-page.mjs';

/** 内页之间的间隔。一次章节十几页连着取，跟限速是一回事 */
const PAGE_GAP_MS = Number(process.env.ZENO_WARM_PAGE_GAP_MS || 250);
/** 内页的硬性上限，防着站点自己把 (1/N) 写错把循环拖死 */
const HARD_CAP = 500;
/** 没有 (1/N) 标记时最多认几页。见下面"不去探"那段 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 抄 imageUrlsFromHtml：属性名由插件配，不写死 src。
 *
 * 很多站的 src 里放的是框架绑定符号（`[src]="chapter00Src"`），真实地址在
 * data-src —— 写死 src 的话一张都解不出来。
 */
export function imageUrlsFromHtml(html, plugin) {
  const re = new RegExp(
    `${escapeRe(plugin.parse.imageAttr)}="(https?://[^"]+?\\.(?:jpg|jpeg|png|webp))"`,
    'gi',
  );
  return [...html.matchAll(re)].map((x) => x[1]);
}

/**
 * 抄 declaredPages：章节被拆成几个内页时，标题里写着 "(1/3)"。
 *
 * **只认第一个数是 1 的那种** —— 它必须是"本页是整章的第 1 页"这个意思，
 * 而不是章节标题里恰好出现的一串括号（"第2话 (3/5)" 那种会把我们骗到
 * 只取 5 页中的第 1 页去）。
 */
export function declaredPages(html) {
  const m = html.match(/\(1\/(\d+)\)/);
  return m ? Math.max(1, Number(m[1]) || 1) : null;
}

/** 章节地址。跟 engine.ts 的 chapterUrl 同一个拼法（fill 就是 fillTemplate） */
export function chapterUrl(plugin, slug, id) {
  return new URL(fill(plugin.urls.chapter, { slug, id }), plugin.chapterHost ?? plugin.entry).toString();
}

/**
 * 这一章的图片地址表。
 *
 * 三条路，跟客户端 getChapter 一一对应：
 *   1. 声明了 capture 且章节页是 browser 模式 —— 渲染时直接从页面自己的 JSON 里
 *      抓整张表（翻页式阅读器：DOM 同一时刻只挂 3 张图，正则解 DOM 是解不全的）；
 *      抓空了就退回正则，两种形态都能读。
 *   2. fetch 模式且写着 (1/N) —— 取第 1 页，剩下的内页并发不了（这里按顺序取，
 *      后台不该跟用户抢闸），一页一页补齐。
 *   3. fetch 模式、没有 (1/N) —— **只认第 1 页，不去逐页探**。
 *
 * 第 3 条是跟客户端唯一的差别，故意的：客户端那条是"一页一页探到 404 为止"，
 * 有人在现场等结果，多挨几个 404 无所谓；后台循环去探，等于拿一个不确定的
 * 上限反复敲站点。代价是这种站的多页章节只会铺到第 1 页 —— 所以调用方会拿到
 * `partial`，界面上就不该给这一章挂"已缓存"的标记，而不是假装铺完了。
 *
 * 一张都没解出来时抛错：空表被当成"取到了"，台账就会记成一章已缓存，
 * 而用户翻过去是一张都还没有。
 */
export async function resolveChapter(plugin, slug, chapterId) {
  const urlFor = (id) => chapterUrl(plugin, slug, id);
  const seen = new Set();
  const images = [];
  const add = (urls) => {
    for (const u of urls) {
      if (seen.has(u)) continue;
      seen.add(u);
      images.push(u);
    }
  };

  if (captureFor(plugin, 'chapter') && modeFor(plugin, 'chapter') === 'browser') {
    const { html, images: captured } = await fetchPage(plugin, urlFor(chapterId), 'chapter');
    add(captured.length ? captured : imageUrlsFromHtml(html, plugin));
    if (!images.length) throw new Error('这一章没有解析出任何图片地址');
    return { images, partial: false };
  }

  const first = await fetchPage(plugin, urlFor(chapterId), 'chapter');
  add(imageUrlsFromHtml(first.html, plugin));

  const declared = declaredPages(first.html);
  const total = declared ?? 1;
  const configured = plugin.maxChapterPages ?? 0;
  const cap = configured > 0 ? Math.min(configured, HARD_CAP) : HARD_CAP;
  let partial = false;
  if (total > 1) {
    for (let p = 2; p <= Math.min(total, cap); p++) {
      await sleep(PAGE_GAP_MS);
      try {
        const r = await fetchPage(plugin, urlFor(`${chapterId}_${p}`), 'chapter');
        add(imageUrlsFromHtml(r.html, plugin));
      } catch (e) {
        // 404/410 = 这一页真的不存在，章节到此为止；别的失败是"没取全"，得记下来
        if (!/HTTP 404|HTTP 410/.test(String(e?.message ?? e))) partial = true;
        break;
      }
    }
  } else if (declared === null) {
    // 站点没写页码标记，而页面看着还有后续内页 —— 标出来，让界面别挂"已缓存"
    partial = looksMultiPage(first.html);
  }

  if (!images.length) throw new Error('这一章没有解析出任何图片地址');
  return { images, partial };
}

/**
 * 这页像不像"其实还有后续内页"。
 *
 * 只用来把 partial 标出来，不用来决定要不要多取一页 —— 判据是页面里出现了
 * 指向 `_2` 那种内页链接。宁可少标也别漏标：标了 partial 只是少一个标记，
 * 漏标则是界面在撒谎。
 */
function looksMultiPage(html) {
  return /_\d+\.html/.test(String(html)) || /\(\d+\/\d+\)/.test(String(html));
}
