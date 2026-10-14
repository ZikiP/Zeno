<div align="center">

# Zeno

**干净的网页阅读器。跨端 PWA，内容源由你自行配置。**

[MIT](LICENSE) · [免责声明](DISCLAIMER.md)

</div>

---

## 这是什么

一个阅读器框架：书架、搜索、离线缓存、双模式阅读（竖滚 / 翻页），
覆盖手机、平板、Web，界面无广告无追踪。

**Zeno 不内置任何站点。** 站点地址与解析规则由使用者在应用内填写，
只保存在本地浏览器，仓库里不出现任何具体内容源。

## 为什么这样设计

站点改版是这类工具的常态。把站点信息做成配置而非代码，有三个好处：

1. **站点改版不用等发版** —— 改设置里的正则即可
2. **仓库不指向任何内容源** —— 作者与内容来源无关
3. **隐私** —— 你的浏览记录只在你自己的设备上

## 运行

```bash
npm install

# 终端 1：CORS 代理（必须先起，并指定允许的站点域名）
ALLOWED_HOSTS=example.com,cdn.example.com node server/proxy.mjs

# 终端 2：开发
npm run dev
```

打开后进入「设置 → 添加站点」，填写站点信息与解析规则，
点「测试解析」确认能抓到内容，保存并启用。

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

## 如何配置一个站点

在「设置 → 添加站点」里填四类信息：

**URL 模板** —— `{变量}` 会被替换

| 字段 | 模板示例 |
|---|---|
| 搜索 | `/search?q={q}` |
| 分类 | `/classify?region={region}&state={state}` |
| 详情 | `/comic/{slug}` |
| 章节 | `/comic/chapter/{slug}/{id}.html` |

**解析规则** —— 正则与选择器

| 字段 | 说明 | 示例 |
|---|---|---|
| 卡片起始片段 | 切分每部漫画的标记，**必须是标签开头** | `<div class="comic-card` |
| slug 提取正则 | 需含一个捕获组 | `href="/comic/([^"]+)"` |
| 标题来源 | 属性名或标签名 | `title` / `h3` |
| 封面提取正则 | 从卡片内提取图片地址 | `https?://[^"'\s]*?/cover/[^"'\s?]+\.jpg` |
| 章节条目标识 | 用于定位章节链接 | `class="chapter-item"` |
| 图片真实地址属性 | **见下方注意事项** | `data-src` |

### 三个容易踩的坑

1. **卡片起始片段不能用 CSS 选择器**，它是「字符串切分点」。
   如果填 `.comic-card`，会连页面 `<style>` 里的 CSS 规则一起切进去。
   必须填 `<div class="comic-card` 这样的标签开头。

2. **图片属性不一定是 `src`**。很多用前端框架的站点，
   `src` 里是绑定符号或运行时占位值，真实地址在 `data-src`、
   `data-original` 之类的属性上。打开开发者工具看真实地址在哪个属性里。

3. **AMP 站点会编码 `/`**。抓到的 HTML 里图片路径可能是 `&#x2F;`，
   本项目已自动解码，不用额外处理。

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
  site/types.ts       站点配置类型定义
  site/engine.ts      通用抓取与解析引擎（不含任何站点信息）
  store/db.ts         IndexedDB：站点配置、书架、阅读进度、离线缓存
  store/SiteContext   当前站点上下文
  pages/              书架 / 发现 / 详情 / 阅读器 / 设置
server/proxy.mjs      CORS 代理（域名白名单 + 并发限流 + 重试）
scripts/gen-icons.ts  从 SVG 生成 PWA 图标
```

## 隐私与合规

请在使用前阅读 [免责声明](DISCLAIMER.md)。要点：

- 仓库不含任何内容、图片或站点配置
- 通过本工具访问内容产生的责任由使用者自行承担
- 请遵守目标站点的服务条款与当地法律法规
- 若某站点条款禁止自动化访问，请勿使用本工具访问它

## 开发

```bash
npm run typecheck
npm run build
npm run icons   # 重新生成 PWA 图标
```
