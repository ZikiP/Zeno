# README

跨端漫画阅读器。手机 / 平板 / Web 一套代码，无广告阅读体验。

## 解决的核心问题

目标站点不返回 `Access-Control-Allow-Origin`，浏览器无法直连；
纯前端方案会被 CORS 挡死。本项目用一个极简 Node 代理转发所有上游请求。

## 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | React 18 + TypeScript | 三端共用一套代码 |
| 构建 | Vite 5 | 冷启动快，PWA 插件成熟 |
| PWA | vite-plugin-pwa (Workbox) | 安卓可「添加到主屏幕」，不需要应用商店和签名证书 |
| 存储 | idb (IndexedDB) | 容量远大于 localStorage，能存整章图片 |
| 路由 | react-router-dom | |
| 代理 | 原生 node:http | 零依赖，约 100 行 |

没用 Flutter / React Native：它们在 Web 端是二等公民，三端就要写三份。

## 运行

```bash
npm install

# 终端 1：CORS 代理（必须先起）
node server/proxy.mjs

# 终端 2：开发
npm run dev        # http://localhost:5178

# 构建
npm run build      # 产物在 dist/
npm run preview    # 预览构建产物
```

手机连同一 WiFi，访问 dev server 打印的 Network 地址即可。

## 生产部署

1. `dist/` 交给任意静态服务器
2. `server/proxy.mjs` 挂在同一域名下的 `/api` 路径（前端写死了 `/api/proxy?url=`）

代理服务监听 `PORT` 环境变量，默认 8788。

## 项目结构

```
src/
  site/twmanga.ts      站点适配层 —— 唯一直接碰站点 DOM 的文件
  store/db.ts          IndexedDB：书架、阅读进度、离线章节缓存
  pages/               书架 / 发现 / 详情 / 阅读器
  components/          UI 组件与图标
server/proxy.mjs       CORS 代理（含上游域名白名单 + 并发限流）
scripts/
  probe.ts             站点适配层验证（npm run probe）
  gen-icons.ts         从 SVG 生成 PWA 图标
  stress-proxy.mjs     代理并发压测
```

## 站点适配层要点

目标站点是 AMP + Vue 3 混合架构，纯 HTTP 可抓，不需要浏览器渲染。

| 环节 | URL / 选择器 |
|---|---|
| 搜索 | `GET /search?q=` |
| 分类 | `/classify?type=&region=&state=&filter=*` |
| 详情 | `/comic/{拼音slug}`，章节项 `class="comics-chapters__item"` |
| 章节跳板 | `/user/page_direct?comic_id=X&chapter_slot=C` → 302 |
| 章节页 | `twbzmg.com/comic/chapter/{slug}/{section}_{chapter}.html` |
| 图片 | 在 `data-src` 属性里 |

### 踩过的坑

1. **不能用 `split('comics-card')` 解析卡片** —— 页面 `<style>` 里也有 `.comics-card` 的 CSS 规则，
   必须锚定 `<div class="comics-card` 这个真实标签开头。
2. **不能用 `src` 取图片** —— Vue 用 `[src]="chapter00Src"` 绑定，真实 URL 在 `data-src`。
3. **AMP 会把 `/` 编码成 `&#x2F;`** —— 抓取前必须先解码 HTML 实体。
4. **上游并发不能开太大** —— 浏览器一次拉 38 张封面会把 CDN 打挂导致裂图，
   代理里做了信号量限流（默认 6 并发）+ 失败重试。
5. **IndexedDB 的 keyPath 必须与查询用的 key 一致** —— 同一漫画多章节要存多条，
   用 `${slug}/${chapterId}` 组合键当 keyPath。

## 广告与追踪

不渲染站点的任何页面，只取结构化数据，因此站点的这些内容一个都不会出现：

- `#div_top_ads` 顶部广告位
- `.mobadsq` 移动端弹窗广告
- `.div_adhost` 广告宿主
- outbrain 推荐广告、googletagmanager、statcounter 追踪

## 验证

```bash
npm run probe    # 站点适配层：搜索/分类/详情/章节图片，全部断言
npm run typecheck
npm run build
```

`probe` 是真实网络请求，覆盖：搜索结果数、封面解析率、章节升序、
图片 URL 合法性（绝对地址、去重、无占位图）、首图可下载性。
