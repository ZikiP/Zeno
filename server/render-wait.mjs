/**
 * 渲染时"等到内容到位"的判据
 *
 * 从 render.mjs 抽出来：那三个判据各自都有实测踩坑史，混在浏览器池的
 * 生命周期代码里既读不动也让那边超了行数上限。这里只管"什么时候算等到了"。
 */

/** 捕获命中后再采样的周期 */
const CAPTURE_POLL_MS = 200;
/** 连续这么多次数量没再变，才认为这张表发完了 */
const CAPTURE_STABLE_SAMPLES = 2;
/** 稳定确认的总预算：防着一张永远在加载的页面把渲染槽钉死 */
const CAPTURE_STABLE_MAX_MS = 1_500;
/** 页面加载完之后再安静多久就算"它不会再吐内容了"（空列表的搜索靠它收摊） */
const QUIET_MS = 2_500;

/**
 * 捕获命中之后，再确认它不再增长。
 *
 * 一次交付的站点（实测拷贝漫画整章 21 / 57 条都在同一个 JSON 里）只多付两个
 * 采样周期；分批交付的站点不等就会只回来头几张 —— 那会被读成"这一章就这么短"，
 * 比慢更糟。
 */
async function settleCaptures(page, deadlineLeftMs) {
  const budget = Math.min(CAPTURE_STABLE_MAX_MS, Math.max(CAPTURE_POLL_MS, deadlineLeftMs));
  const t0 = performance.now();
  let last = -1;
  let same = 0;
  while (same < CAPTURE_STABLE_SAMPLES && performance.now() - t0 < budget) {
    const n = await page.evaluate(() => (window.__zenoCap || []).length).catch(() => last);
    same = n === last ? same + 1 : 0;
    last = n;
    if (same >= CAPTURE_STABLE_SAMPLES) break;
    await page.waitForTimeout(CAPTURE_POLL_MS).catch(() => {});
  }
}

/** 站点的「正在验证浏览器」质询壳特征。小写后比对，所以中英混着写都行 */
const CHALLENGE_MARKERS = [
  '__gatekeeper_challenge',
  '正在验证浏览器',
  'data-state="checking"',
  'just a moment',
  'checking your browser',
  'cf-chl',
  'challenge-platform',
];
const CHALLENGE_POLL_MS = 500;

export function isChallengeHtml(html) {
  const h = String(html).toLowerCase();
  return CHALLENGE_MARKERS.some((m) => h.includes(m.toLowerCase()));
}

/**
 * 停在浏览器质询页时，等它自己走完。
 *
 * 为什么必须等：质询页的 JS 会自己重新加载目标页，而这次重载会炸掉
 * waitForFunction 的执行上下文 —— 判据于是"失败"，快照正好落在重载前的
 * 空壳上。实测 baozimh 详情页就是这么返回 2383 字节的质询壳、0 条章节。
 *
 * 返回最后一次的 HTML 和"是否还停在质询页"。
 */
export async function waitOutChallenge(page, budgetMs) {
  let html = await page.content().catch(() => '');
  if (!isChallengeHtml(html)) return { html, challenged: false };

  /*
   * "连续两次稳定"才算解开。质询往往连着重载好几跳，跳与跳之间
   * page.content() 拿到的是导航中途的空白文档 —— 它不含任何质询特征，
   * 看一眼就放行等于在质询没走完时收手（线上实测：1.85s 返回一张壳）。
   * 所以除了"不像壳"，还要求文档已 complete、有 body、且不是几张字节。
   */
  const t0 = performance.now();
  let calm = 0;
  while (performance.now() - t0 < budgetMs) {
    await page.waitForTimeout(CHALLENGE_POLL_MS).catch(() => {});
    html = await page.content().catch(() => html);
    const ready = await page
      .evaluate(() => document.readyState === 'complete' && document.body !== null)
      .catch(() => false);
    if (!isChallengeHtml(html) && ready && html.length > 3_000) {
      if (++calm >= 2) return { html, challenged: false };
    } else {
      calm = 0;
    }
  }
  return { html, challenged: true };
}

/**
 * 等"内容到位"，判据按插件声明选一个：
 *
 *  - 声明了 `capture` → 只等页面里的 JSON 捕获攒到至少 1 条。
 *    **选择器不能参与这场竞赛**：SSR 壳里本来就挂着一张占位 `<img>`，
 *    让它先"成功"就等于在站点自己的 JS 解出正文表之前几百毫秒收摊，
 *    捕获永远是空的（实测踩过，就是这么测出来的）。
 *  - 只声明 `waitFor` → 等该选择器的数量达到 `minCount`（缺省 1）。
 *    要的是数量而不是"出现过"：详情页的 SSR 里就有 1 条章节链接，
 *    等它出现等于没等 —— 实测 1 条 vs 等够 20 条时拿到 375 条。
 *  - 都没声明 → 等 load。
 *
 * 命中就返回判据名（capture / selector / idle / load）；
 * 到期没满足返回 null，调用方回落到 DOM 解析。
 */
export async function waitUntilSettled(page, opts, timeoutMs) {
  if (opts.capture) {
    const hit = await page
      .waitForFunction(() => (window.__zenoCap || []).length > 0, null, {
        polling: 100,
        timeout: timeoutMs,
      })
      .then(() => true, () => false);
    if (!hit) return null;
    await settleCaptures(page, timeoutMs);
    return 'capture';
  }

  if (opts.waitFor) {
    const min = Math.max(1, Number(opts.minCount) || 1);
    const ac = new AbortController();
    const enough = page
      .waitForFunction(
        ([sel, n]) => document.querySelectorAll(sel).length >= n,
        [opts.waitFor, min],
        { polling: 150, timeout: timeoutMs, signal: ac.signal },
      )
      .then(() => 'selector', () => null);

    /*
     * "等够数量" 和 "页面不再往外吐东西了"，哪个先到算哪个 —— 下限是 1 也照跑。
     *
     * 少了后半条有两种坏结果：
     *  - 搜一个不存在的词，30 秒全花光再报超时。列表本来就是空的，数量到不了下限，
     *    用户看到的行为是"搜索卡死"，而正确答案是"没有结果"。
     *  - 更糟的是这一章/这本根本没有目录（实测 baozimh 有本书页面 200、101KB，
     *    但一本漫画都没有）：45 秒预算一路点满，还把一格渲染并发钉死。
     *    MAX_PAGES 只有 3，三次这样的页面就是全站 429。
     *
     * 安静窗口从 1.5s 提到 2.5s：下限为 1 的页也走这条以后，纯客户端渲染的站
     * 要有足够时间把内容 hydrate 出来，不然"还没长出来"会被读成"这站没东西"。
     *
     * readyState 停在 loading 是这条判据唯一的护栏：图片还没落地 = load 没到 =
     * 不抢跑。所以别在渲染时拦子资源来"提速" —— 实测拦掉图片后，一个 4s 才
     * hydrate 完的页面在 2.9s 就返回空 DOM 了，省下的那点流量换来的是读错内容。
     */
    const quiet = page
      .waitForFunction(
        ([sel, quietMs]) => {
          const w = (window.__zenoQuiet ||= {});
          if (document.readyState !== 'complete') return false;
          const n = document.querySelectorAll(sel).length;
          if (n !== w.n) {
            w.n = n;
            w.at = performance.now();
            return false;
          }
          return performance.now() - (w.at ?? 0) >= quietMs;
        },
        [opts.waitFor, QUIET_MS],
        { polling: 200, timeout: timeoutMs, signal: ac.signal },
      )
      .then(() => 'idle', () => null);

    const winner = await Promise.race([enough, quiet]);
    ac.abort();
    return winner;
  }

  return page.waitForLoadState('load', { timeout: timeoutMs }).then(() => 'load', () => null);
}
