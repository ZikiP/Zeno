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

### 自托管（多端同步）

一台机器 + Tailscale，手机平板电脑共用一份数据：

```bash
npm ci && npm run build
ALLOWED_HOSTS=你的站点域名 node server/index.mjs
tailscale serve --bg 8788
```

一个进程同时提供静态文件、同步 API、抓取代理，数据落在 SQLite（Node 内置，无需编译）。

**必须用 `tailscale serve` 拿 HTTPS** —— 直接用 `http://机器名:端口` 也能通，
但浏览器不认那是安全上下文，Service Worker 不工作，PWA 离线会静默失效。

同步什么、冲突怎么解、Tailscale 常见坑 → **[docs/DEPLOY.md](docs/DEPLOY.md)**

### 仅本地开发

```bash
npm install

# 终端 1：抓取代理（解决目标站点 CORS）
ALLOWED_HOSTS=example.com,cdn.example.com node server/index.mjs

# 终端 2：开发（vite 会把 /api 转发给终端 1）
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

## 验证插件

写好插件后可以在命令行验证，不用开界面：

```bash
node --import tsx scripts/verify-plugin.ts 你的插件.json
```

会依次验证格式、列表、搜索、详情、章节、图片，并输出每一步的实测数量。

## 生产部署

1. `npm run build`，把 `dist/` 交给任意静态服务器
2. 把 `server/proxy.mjs` 挂在同一域名下的 `/api` 路径（前端写死了 `/api/proxy?url=`）

代理环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8788 | 监听端口 |
| `ALLOWED_HOSTS` | 空 | 允许的上游域名，逗号分隔。**不设置则拒绝一切请求** |
| `MAX_CONCURRENT` | 6 | 上游并发上限，过高会被 CDN 限流导致图片裂开 |

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
| 代理 | 原生 `node:http` | 零依赖，一百来行 |

## 项目结构

```
src/
  site/
    types.ts         插件格式定义与校验
    fetch.ts         请求层（代理包装、实体解码、重试）
    parse.ts         解析层（卡片、章节、搜索可信度）
    engine.ts        公开 API，只做编排
  store/
    db.ts            IndexedDB 连接与类型
    plugins.ts       插件
    shelf.ts         书架与进度
    chapters.ts      离线缓存 + 章节表缓存
    bookmarks.ts     书签与笔记
    dataEvents.ts    数据变更广播
    useDataVersion.ts 订阅变更（同步后 UI 自动刷新）
  sync/
    client.ts        同步管理器（网络、状态、定时）
    transfer.ts      本地 ⇄ 服务端数据搬运
    SyncUI.tsx       状态条与设置面板
  reader/prefs.ts    阅读偏好
  hooks/useTheme.ts  主题切换
  pages/             书架 / 发现 / 搜索 / 详情 / 阅读器 / 设置
  components/
    reader/          阅读器专属组件
    ChapterList.tsx  章节列表（分批加载）
    ChapterDrawer.tsx 阅读器内章节目录
    BookmarkPanel.tsx 书签与笔记
    RetryableImage.tsx 带重试的图片
    UI.tsx / Icons.tsx 通用组件与图标
server/
  index.mjs          主服务（静态 + 同步 API + 代理）
  db.mjs             SQLite schema 与变更日志
  merge.mjs          合并策略
  static.mjs         静态文件与 SPA 回退
docs/DEPLOY.md       自托管与 Tailscale 部署
scripts/
  gen-icons.ts       生成 PWA 图标
  verify-plugin.ts   插件命令行验证
  test-sync.mjs      同步 API 往返测试
  test-multidevice.mjs 多端同步验证
```

## 编码规范

见 [CODE-STYLE.md](CODE-STYLE.md)。核心：**组件 ≤ 250 行，工具/hook ≤ 300 行**，
判断标准是「一个文件有几件事」而不是行数。

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
