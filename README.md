<div align="center">

# Zeno

**干净的网页阅读器。跨端 PWA，内容源由你自行配置。**

[MIT](LICENSE) · [免责声明](DISCLAIMER.md) · [编码规范](CODE-STYLE.md)

</div>

---

## 这是什么

一个阅读器框架：书架、搜索、离线缓存、双模式阅读（竖滚 / 翻页），
覆盖手机、平板、Web，支持浅色 / 深色 / 跟随系统。

**Zeno 不内置任何内容源。** 内容以「插件」形式提供 —— 一份可导入导出的 JSON，
说明去哪里、页面长什么样、怎么解析。你可以从别人那里导入，
也可以把自己改好的导出分享。

## 为什么做成插件

| 好处 | 说明 |
|---|---|
| 站点改版不用等发版 | 改插件 JSON 即可，不动代码 |
| 仓库与内容源无关 | 项目不附带、不推荐任何内容源 |
| 可分享 | 一个人写好规则，别人一键导入 |
| 隐私 | 插件只存在你自己的浏览器里 |

## 运行

### 自托管（推荐）

一台机器 + Tailscale，手机平板电脑共用一份数据：

```bash
git clone https://github.com/ZikiP/Zeno.git
cd Zeno
npm install
npm run serve
```

`serve` = 构建 + 启动。**不用配任何环境变量。**

远程访问：

```bash
tailscale serve --bg 8788
```

**必须用 `tailscale serve` 拿 HTTPS** —— 直接用 `http://机器名:端口` 也能通，
但浏览器不认那是安全上下文，Service Worker 不工作，PWA 离线会静默失效。

### 一键部署（生产机）

带脚本，装完就是开机自启的常驻服务：

| 平台 | 命令 | 说明 |
|---|---|---|
| Linux / macOS | `./deploy.sh` | systemd 服务 |
| Windows | `.\deploy.ps1` | 计划任务（默认 SYSTEM 账号 + 崩溃自动重启） |

脚本会做：环境检查 → 装依赖 → 构建 → 注册开机自启 → 健康检查 → 配 Tailscale HTTPS。

```bash
./deploy.sh --port 9000        # 换端口
./deploy.sh --skip-tailscale   # 不配 HTTPS
./deploy.sh --uninstall        # 卸载
```

```powershell
.\deploy.ps1 -RunAsUser        # 任务主体换成当前账号（S4U）—— browser 渲染模式需要它
.\deploy.ps1 -SkipInstall      # 沿用现有依赖与 dist，只重注册常驻任务
.\deploy.ps1 -Mode none        # 不起常驻，前台跑一次（Ctrl+C 退出）
.\deploy.ps1 -Uninstall        # 卸载（数据保留在 data\）
```

**⚠️ 系统开着代理软件（Clash / FlClash 等）时**，浏览器会把 `*.ts.net`
塞进代理，TLS 握手被中断 —— 页面看着正常，请求全挂。脚本会读注册表检出这个情况
并提示你怎么办。**要改的是代理软件自己的「绕过」设置，加 `*.ts.net`**；
清环境变量在 Windows 上是空操作（代理状态在注册表，不在 env）。

抓取白名单**从已安装的插件自动推导** —— 装好插件服务端立刻放行对应站点。

同步什么、冲突怎么解、Tailscale 常见坑 → **[docs/DEPLOY.md](docs/DEPLOY.md)**

### 仅本地开发

```bash
npm install

# 终端 1：服务端（抓取代理 + 同步 API）
npm start

# 终端 2：前端（vite 把 /api 转发给终端 1）
npm run dev
```

进「设置 → 内容源插件 → 导入」，选一个 `.json` 插件文件。
导入后会自动设为当前插件，可以点「测试解析」验证规则是否匹配目标站点。

## 插件格式

插件是 `zeno-plugin@1` 格式的 JSON：

```json
{
  "format": "zeno-plugin@1",
  "meta": {
    "id": "example",
    "name": "示例站点",
    "description": "一句话说明",
    "author": "你的名字",
    "version": "1.0.0",
    "icon": "📚"
  },
  "entry": "https://example.com",
  "chapterHost": "https://example.com",
  "urls": {
    "search": "/search?q={q}",
    "classify": "/classify?region={region}&state={state}",
    "detail": "/comic/{slug}",
    "chapter": "/comic/chapter/{slug}/{id}.html"
  },
  "parse": {
    "card": "<div class=\"comic-card",
    "slugFrom": "href=\"/comic/([^\"?]+)\"",
    "title": { "attr": "title" },
    "cover": "https?://[^\"'\\s]*?/cover/[^\"'\\s?]+\\.jpg",
    "chapterItem": "class=\"chapter-item\"",
    "chapterIdFrom": "/(\\d+)_(\\d+)\\.html",
    "imageAttr": "data-src"
  },
  "imageHosts": ["cdn.example.com"],
  "fetch": { "mode": "browser", "waitFor": ".comic-card" },
  "headers": {}
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `entry` | 入口域名 |
| `chapterHost` | 章节页域名，留空则同入口 |
| `urls.*` | URL 模板。`{q}` 搜索词、`{slug}` 漫画标识、`{id}` 章节 id |
| `parse.card` | **字符串切分点，必须填标签开头** |
| `parse.slugFrom` | 提取漫画标识，需一个捕获组 |
| `parse.title` | `{attr:"title"}` 按属性，或 `{tag:"h3"}` 按标签 |
| `parse.cover` | 提取封面地址的正则 |
| `parse.chapterItem` | 章节条目在 `<a>` 上的 class |
| `parse.chapterIdFrom` | 提取章节 id，需**两个**捕获组：分区、序号 |
| `parse.imageAttr` | 图片真实地址所在的属性名 |
| `imageHosts` | 图片 CDN 域名，用于代理白名单提示与离线缓存 |
| `fetch.mode` | `fetch`（默认）或 `browser`。见下「取源方式」 |
| `fetch.waitFor` | browser 模式：渲染后等这个 CSS 选择器出现再取 HTML |
| `fetch.timeoutMs` | 单次取源上限，默认 20000 |

### 写插件时的四个坑

1. **`card` 不能填 CSS 选择器。** 它是字符串切分点。填 `.comic-card` 会把
   `<style>` 里同名的 CSS 规则一起切进来。必须填 `<div class="comic-card`。

2. **图片地址不一定在 `src`。** 用前端框架的站点常把真实地址放在
   `data-src` / `data-original`，而 `src` 里是绑定符号或占位图。
   打开开发者工具看真实地址在哪个属性。

3. **`chapterIdFrom` 要两个捕获组。** 章节 URL 有两种形态：
   - 路径式 `/chapter/{slug}/0_562.html` → `/(\d+)_(\d+)\.html`
   - 参数式 `/page_direct?section_slot=0&chapter_slot=562` → `section_slot=(\d+)&chapter_slot=(\d+)`

4. **AMP 站点会编码 `/`。** 抓到的 HTML 里路径可能是 `&#x2F;`，
   本项目已自动解码，不用额外处理。

## 取源方式：`fetch` 与 `browser`

默认 `fetch` —— 服务端直接 HTTP 取 HTML，快（约 200ms），但**拿不到需要执行
JS 才出内容的页面**：前端渲染的站点会拿到空壳。

`"fetch": { "mode": "browser" }` 让服务端用一个真的浏览器引擎渲染后再交回
解析层。**`mode` 也可以按页面类型分开写，而且通常应该这么做**：

```jsonc
"fetch": {
  "mode":    { "list": "browser", "detail": "browser", "chapter": "fetch" },
  "waitFor": { "list": "div.comics-card", "detail": "a.comics-chapters__item" }
}
```

写成字符串就是对列表 / 详情 / 章节**一律**用同一种方式，这几乎总是不划算 ——
质询和前端渲染常常只挂在主站域名上，章节页在另一个域、根本不需要渲染，
而章节恰恰是阅读时最高频的操作。分开写之后实测章节页从 4.76s 降到 1.98s。

代价要清楚（下表为实测值，不是估算）：

| | `fetch` | `browser` |
|---|---|---|
| 单页耗时 | 1–3s | 会话已建立 ~1s；首次要过站点质询时数秒 |
| 失败重试 | 3 次 | **1 次**（重试也改变不了"确实没渲染出来"） |
| 缓存 | `max-age=600` | `no-store`（渲染结果有时效且不幂等） |
| 并发 | 走 `MAX_CONCURRENT` 闸 | **不占该闸**，由 `BROWSER_MAX_PAGES` 单独限流 |
| 内存 | 忽略 | 热了 300–500MB，空闲 60s 自动关 |

服务端**全站共享一个浏览器会话**（context）。这点很关键：每次请求新建 context
会把质询通过后拿到的会话 cookie 丢掉，导致每个页面都从零再解一次质询 ——
实测那样分类页 40s、详情页直接超时；复用会话后只有第一次付这个代价。
渲染也不占抓取闸，否则一次几秒的渲染会卡住同时进行的几十个图片请求
（实测单张图从 1~2s 被拖到 10s+）。

**只作用于 HTML 文档**（列表 / 详情 / 章节页）。图片永远走 `fetch` —— `<img>`
用不上渲染结果，给每张图开一次浏览器也不成立。

需要服务端有 chromium 系浏览器：`ZENO_BROWSER` 指定路径，否则自动探测
ms-playwright 缓存 → Edge → Chrome。部署脚本会检查并告知，**没有也不影响
普通插件**。

> **⚠️ 以 SYSTEM 常驻时 `browser` 模式起不来 —— 用 `-RunAsUser` 解决。**
> `deploy.ps1` 默认把计划任务注册在 `NT AUTHORITY\SYSTEM`（会话 0），实测 Edge 进程
> 启动后立刻以 `exitCode=1002` 退出，Playwright 报
> `Target page, context or browser has been closed`。已排除沙箱原因
> （Playwright 自带 `--no-sandbox`，profile 也落在 `C:\Windows\TEMP`）。
>
> `.\deploy.ps1 -RunAsUser` 把任务主体换成当前账号、登录类型用 S4U ——
> 仍然是「不管用户是否登录都要运行」，注销后服务继续跑，也不把密码存进任务。
> 实测切换后渲染恢复：分类页 7.2s / 73 张卡片，章节 50 张图全部加载成功。
> 只要前台跑的话用 `.\deploy.ps1 -Mode none`，同样以登录用户身份启动。
>
> **插件写了 `fetch.mode="browser"` 就必须走这两条之一**，否则列表页和详情页
> 会一直 503，而 `/api/health` 是绿的 —— 健康检查不碰渲染。

**这个模式不含任何反自动化伪装** —— 不改 `navigator.webdriver`、不伪造指纹、
不破解质询令牌。它的定位是"渲染 JS 生成的页面"，不是"冒充人类绕过机器人的
拦截"。站点如果拒绝自动化客户端，它就应当被拒绝。

## 验证插件

写好插件后可以在命令行验证，不用开界面：

```bash
node --import tsx scripts/verify-plugin.ts 你的插件.json
```

会依次验证格式、列表、搜索、详情、章节、图片，并输出每一步的实测数量。

脚本默认**另起一个隔离的服务端**（独立端口 + 独立临时库）并把插件推上去，
引擎经它的代理取页面 —— 因为 `fetch.mode="browser"` 的渲染发生在服务端，
Node 里直连上游只会拿到质询页，这类插件在脚本里就永远验证不了。
加 `--direct` 可以退回直连（只适合全 `fetch` 模式的插件）。

## 生产部署

一条命令：`node server/index.mjs`。它同时提供静态文件、同步 API 和抓取代理，
**不需要把 `proxy.mjs` 单独挂到 `/api`** —— 前端写死的 `/api/proxy?url=`
就是这个服务自己的路径。要拆开部署也可以，只要保证 `/api/*` 与页面同源。

服务端环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8788 | 监听端口 |
| `DIST_DIR` | `dist` | 静态目录。作为系统服务运行时 cwd 不是项目目录，**要给绝对路径** |
| `DB_PATH` | `data/zeno.db` | SQLite 路径。同上，建议绝对路径 |
| `SYNC_TOKEN` | 空 | 设了之后同步 API 与代理都要 Bearer token |
| `ALLOWED_HOSTS` | 空 | 额外允许的上游域名，逗号分隔。装了插件后会自动并入插件的域名 |
| `MAX_CONCURRENT` | 6 | 上游并发上限，过高会被 CDN 限流导致图片裂开 |
| `UPSTREAM_TIMEOUT_MS` | 20000 | 单次上游请求上限 |
| `ALLOW_PRIVATE_HOSTS` | 关 | 设 `1` 才放行解析到内网/回环的目标。**仅供本地开发与测试** |
| `ZENO_BROWSER` | 自动探测 | `fetch.mode="browser"` 用的浏览器可执行文件路径 |
| `BROWSER_IDLE_MS` | 60000 | 渲染浏览器空闲多久后关闭 |
| `BROWSER_MAX_PAGES` | 3 | 同时打开的渲染页面上限 |
| `RENDER_TTL_MS` | 90000 | 渲染结果缓存时长。设 0 等于关掉缓存 |

### 抓取代理的地址策略（SSRF）

域名白名单只挡"允许哪些域名"，挡不住"这个域名解析到哪"。所以代理还有第二道闸：
目标解析出的每个 IP 都必须是公网可路由地址，**回环、RFC1918、链路本地
（含 `169.254.169.254` 云元数据）、CGNAT `100.64.0.0/10`（Tailscale 段，含服务自己）、
组播、保留段一律拒绝**，`localhost` / `*.internal` / 单标签主机名也直接拒。

上游返回 3xx 时**逐跳自己跟、逐跳重新校验** —— 交给 `fetch` 的 `redirect: 'follow'`
等于开后门（白名单域名回一个 `302 → http://127.0.0.1` 就绕过了两道闸）。

> **残留风险**：校验是"先解析、再请求"，两次解析之间 DNS 记录可以变（rebinding）。
> 彻底闭环要在建连时再校验一次，Node 的全局 `fetch` 不暴露那个钩子。
> 本工具的威胁模型是"别人分享给你的插件文件"，按这个尺度请求时校验是合适的强度；
> 要接对抗性威胁模型就得换成带自定义 `lookup` 的 connector。

白名单支持子域名：填 `example.com` 会放行 `cdn.example.com`。
插件编辑器会自动算出需要放行的域名并显示。

## 主题

| 模式 | 行为 |
|---|---|
| 浅色 | `<html data-theme="light">` |
| 深色 | `<html data-theme="dark">` |
| 跟随系统 | 不写属性，由 `prefers-color-scheme` 决定，**实时响应系统切换** |

新增主题只需在 `src/styles.css` 里加一组 CSS 变量，组件不用改。

## 阅读器

| 能力 | 说明 |
|---|---|
| 两种阅读方式 | 竖向滚动（适合手机长章节）、左右翻页（适合平板） |
| **翻页方向** | 右起（日漫习惯）/ 左起（国漫韩漫习惯），键盘 `D` 快速切换 |
| **双页显示** | 横屏一屏两页，适合平板 |
| **章节导航** | 章末直接「上一章 / 下一章」，翻页到底点一下就切过去 |
| **章节目录** | 阅读器内直接翻目录（`C`），不用退回详情页 |
| **书签与笔记** | 收藏任意页（`B`），可写笔记，进度条上标出位置 |
| **边界反馈** | 到头时提示「已是第一章 / 下一章」，而不是点了没反应 |
| 进度条 | 底部细条显示位置，点击可跳转；已收藏页在条上标记 |
| 预加载 | 当前页前后各 2 张提前加载，翻页不等待 |
| **图片自动重试** | 单张失败自动重试 3 次（退避 0/600/1800ms），仍失败可手动点重试 |
| 离线识别 | 离线时图片位置显示「离线中，无法加载」而不是空白 |
| **长按/双击放大** | 看不清细节时用，点击任意处关闭 |
| **保持屏幕常亮** | Wake Lock API，页面隐藏自动释放 |
| **亮度调节** | 30%–100% 应用内调暗，不改系统设置 |
| 背景色 | 纯黑 / 深灰 / 护眼 / 中性 |
| 灰度模式 | 去掉颜色，省流量 |
| 离线缓存 | 打开过的章节自动缓存，断网可读 |
| 进度记忆 | 滚动位置与页码自动保存，重进还原 |

**电脑端快捷键**：`←` `→` 翻页　`空格`/`F` 工具栏　`D` 切换方向　`B` 收藏本页　`C` 章节目录　`K` 书签面板　`+` `-` 亮度　`Esc` 返回

### 跨插件全局搜索

底栏「搜索」进入。可勾选要搜的插件，并发查询后合并结果。

**关键细节**：不同站点的同名 slug 指向完全不同的漫画。所以点搜索结果时，
若结果来自非当前插件，会**先切换插件再跳转**，否则打开的是错的源。

搜索历史只写本地（8 条），点「清空」即删。

## 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | React 18 + TypeScript | 跨端共用一套代码 |
| 构建 | Vite 5 | 冷启动快，PWA 插件成熟 |
| PWA | vite-plugin-pwa (Workbox) | 手机可「添加到主屏幕」，不需要应用商店与签名证书 |
| 存储 | idb (IndexedDB) | 容量足够存整章图片 |
| 图标 | lucide-react | ISC 许可、零依赖、可 tree-shake。自绘的 22 个里有几组彼此认不出来，换库比逐个修更省事（22 个图标实测 +3.4 kB gzip） |
| 路由 | react-router-dom 6 | 只有 6 个路由，声明式 `<Routes>` 就够，没上 data router |
| 代理 | 原生 `node:http` | 零依赖，一百来行 |
| 渲染 | playwright-core + 系统浏览器 | `fetch.mode="browser"` 需要真的 JS 引擎。只驱动已装好的 Edge/Chrome，不下浏览器 |

### 依赖告警的处置

`npm audit` 目前报 react-router 的 [GHSA-337j-9hxr-rhxg](https://github.com/advisories/GHSA-337j-9hxr-rhxg)
（`deserializeErrors()` 任意构造器注入），修复方式是升到 7.x —— 一个破坏性大版本。

**本项目不受影响，理由是这条路径根本不存在**：该缺陷在 SSR hydration / data router
的 `Hydrate` 流程里，错误对象由服务端序列化、客户端 `deserializeErrors()` 反序列化。
Zeno 是纯客户端 SPA，没有 SSR、没有 loader/action、没有 `HydratedRouter`，
反序列化那一步不会执行。所以不为了消掉一行告警去做 6→7 的迁移。

要复核的话：`grep -rn "createBrowserRouter\|Hydrat\|useLoaderData\|useActionData" src/` 应该没有结果。

## 项目结构

```
src/
  site/
    types.ts         插件格式的类型定义与空白模板
    validate.ts      导入期校验（正则能否编译、URL 模板、字段形状）
    fetch.ts         请求层（代理包装、实体解码、重试、FetchError）
    parse.ts         解析层（卡片、章节、搜索可信度）
    engine.ts        公开 API，只做编排
  store/
    db.ts            IndexedDB 连接与类型
    plugins.ts       插件
    shelf.ts         书架与进度
    chapters.ts      离线缓存 + 章节表缓存
    bookmarks.ts     书签与笔记
    tombstones.ts    删除墓碑（让删除能同步出去）
    dataEvents.ts    数据变更广播
    useDataVersion.ts 订阅变更（同步后 UI 自动刷新）
    useOfflineCache.ts 一部漫画的离线缓存与整本下载
  sync/
    client.ts        同步管理器（网络、状态、定时）
    transfer.ts      本地 → 服务端（只读，整理成推送格式）
    applyRemote.ts   服务端 → 本地（单个 IndexedDB 事务落库）
    SyncUI.tsx       状态条与设置面板
  reader/prefs.ts    阅读偏好
  hooks/useTheme.ts  主题切换
  pages/             书架 / 发现 / 搜索 / 详情 / 阅读器 / 设置
    reader/          阅读器的 hooks（动作、快捷键、分页、书签）
  components/
    reader/          阅读器专属组件
    BottomNav.tsx    底部导航
    ChapterList.tsx  章节列表（分批加载）
    ChapterDrawer.tsx 阅读器内章节目录
    BookmarkPanel.tsx 书签与笔记
    RetryableImage.tsx 带重试的图片
    UI.tsx / Icons.tsx 通用组件与图标（图标来自 lucide-react）
server/
  index.mjs          启动与请求分发（静态 / 同步 / 代理 各归各的模块）
  sync-api.mjs       同步与状态端点
  merge.mjs          合并策略（增的一侧）
  deletes.mjs        删除墓碑的应用与插件级联
  lww.mjs            增删两侧共用的 LWW 判据
  proxy.mjs          抓取代理：白名单 → 地址策略 → fetch 或浏览器渲染
  allowlist.mjs      抓取白名单（从已装插件推导）与域名匹配
  render.mjs         浏览器渲染池（fetch.mode="browser" 的后端）+ 结果缓存
  ssrf.mjs           目标地址策略：拒绝内网 / 回环 / 元数据 / CGNAT
  db.mjs             SQLite schema 与变更日志
  respond.mjs        JSON 响应、请求体上限、令牌比较
  static.mjs         静态文件与 SPA 回退
deploy.sh            Linux / macOS 一键部署（systemd）
deploy.ps1           Windows 一键部署（计划任务）
docs/DEPLOY.md       自托管与 Tailscale 部署
scripts/
  run-tests.mjs      测试编排（每个套件独立端口 + 独立临时库）
  test-sync.mjs      同步 API 往返
  test-multidevice.mjs 多端同步
  test-deletes.mjs   删除传播与"删了又加回来"
  test-whitelist.mjs 域名白名单自动推导
  test-ssrf.mjs / test-auth.mjs 地址策略与鉴权覆盖
  test-validation.ts 插件校验行为（直接跑 src 里的真源码）
  gen-icons.ts       生成 PWA 图标
  verify-plugin.ts   插件命令行验证（含 browser 模式）
  verify-render.mjs  渲染差分与缓存验证
  verify-sync-e2e.mjs 真浏览器验客户端落库
  verify-ui.mjs      真浏览器界面走查（溢出、按钮挤压、封面是否真加载）
  install-plugin.mjs / stress-proxy.mjs
```

`verify-*` 与 `stress-proxy` 依赖本机浏览器或外网，不进 `npm test` ——
在 CI 上它们只会假失败。

## 编码规范

见 [CODE-STYLE.md](CODE-STYLE.md)。核心：**组件 ≤ 250 行，工具/hook ≤ 300 行**，
判断标准是「一个文件有几件事」而不是行数。

## 部署 Skill

[`.claude/skills/zeno-deploy/`](.claude/skills/zeno-deploy/) 是本仓库自带的部署 skill。

在 Claude Code 里提到"部署 Zeno"就会自动加载，包含：

- 一键部署流程与两种常驻方案（systemd / 计划任务）
- **代理会搞挂 Tailscale 证书签发**这个坑及解法
- Windows 特有注意事项（PS 5.1 不支持 `??`、计划任务不落 stdout）
- 9 项常见故障排查表

也可以直接当文档读。

## 隐私与合规

请在使用前阅读 [免责声明](DISCLAIMER.md)。要点：

- 仓库不含任何内容、图片或默认插件
- 通过本工具访问内容产生的责任由使用者自行承担
- 请遵守目标站点的服务条款与当地法律法规
- 若某站点条款禁止自动化访问，请勿使用本工具访问它
- 导入他人插件即表示你自行判断并接受其内容与用途

## 开发

```bash
npm run typecheck
npm run build
npm run icons   # 重新生成 PWA 图标
```
