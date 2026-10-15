# 编码规范

> 善于拆分组件和模块化，不要一个大文件很多很多行，后期很难维护和迭代。

## 为什么要有这份文档

2026-10-14 自查发现三个文件严重超标：

| 文件 | 行数 | 混在一起的事 |
|---|---|---|
| `pages/ReaderPage.tsx` | 772 | 数据加载、进度、书签、键盘、常亮、预加载、4 种渲染分支、设置面板 |
| `pages/SettingsPage.tsx` | 578 | 插件列表 + 表单 + 免责声明 |
| `store/db.ts` | 382 | 6 类数据的读写 |

772 行的组件，任何改动都得在脑子里维护整个文件。

**根因是编码习惯**：写功能时没停下来拆，攒到 700+ 行回头拆已经很陌生了。
所以规则写下来，新功能当场执行。

---

## 文件大小上限

| 类型 | 上限 | 说明 |
|---|---|---|
| 组件文件 | 250 行 | 超了就拆 |
| 工具 / 服务 / hook | 300 行 | 超了就拆 |
| 纯类型定义 | 不限 | 只有声明没有复杂度 |

**判断标准不是行数，是「一个文件有几件事」。**

一个文件只做一件事，哪怕 300 行全是声明，也比 150 行的混合文件好维护。
反过来，250 行里混了三件事照样该拆。

## 拆分原则

按**职责**拆，不按行数硬切。

阅读器是典型例子（772 行一个文件 → 9 个文件）：

```
pages/reader/
├── ReaderPage.tsx        238  只做编排：谁依赖谁
├── ReaderPanels.tsx       85  浮层互斥编排
├── useChapterLoader.ts   171  章节加载 + 进度保存
├── useReaderActions.ts    98  换章 / 收藏 / 跳书签 / 切模式
├── useBookmarks.ts        88  书签
├── usePaging.ts          138  翻页状态机 + 工具栏显隐
├── usePrefs.ts            34  偏好持久化
├── useReaderEffects.ts   127  常亮 + 预加载 + 提示条 + 进度恢复
└── useReaderHotkeys.ts   101  快捷键

components/reader/         每个组件一件事
```

## 什么该抽成组件

| 信号 | 该抽 |
|---|---|
| 一段 JSX 超过 30 行 | 抽组件 |
| 同一个 JSX 块在两处出现 | 抽组件 |
| 渲染分支超过 3 个 | 每个分支一个组件 |
| 组件需要靠注释分段说明「这部分是干什么的」 | 抽 |

## 什么该抽成 hook

| 信号 | 该抽 |
|---|---|
| 一组相关的 state + 操作逻辑 | 抽 hook |
| 有副作用（定时器、事件监听、请求） | 抽 hook |
| 逻辑需要在两处复用 | 抽 hook |

**hook 的边界**：

- 一个 hook 只管一件事（加载 / 键盘 / 书签 / 主题，不要混）
- 返回值不超过 6 个，超过就合并或再拆
- 不要把「每次渲染新建的对象」当参数传（进不了依赖数组）。要传就传基本类型，或用 ref

## 什么不该抽

- 只用一次但**确实独立**的逻辑 → 抽（例：`PrefsSheet` 只用一次，但它是独立 UI）
- 纯粹为了「显得模块化」而拆 → **不要拆**

**判断标准是「改这块时会不会影响别的」。** 会，就拆；不会，就别动。

## 目录约定

```
src/
├── components/
│   ├── <公共组件>.tsx      两个以上页面都在用的
│   └── <域>/              同类组件归堆，如 reader/
├── pages/
│   └── <页面>/            页面私有组件与 hook
├── hooks/                 全局 hook
├── store/                 数据层
└── site/                  站点适配
```

**只有两个以上页面都在用的才进 `src/components/`。**
页面专属的放 `pages/<页>/`，不要污染公共目录。

## 样式

规则本体在 `src/styles/` 下按域分文件，`src/styles.css` 只是入口，
用 `@import` 按层叠顺序串起来。

```
src/styles.css          入口：只有注释和 @import，不写规则
src/styles/
├── tokens.css          设计令牌 —— 改主题只动这里
├── glass.css           材质层：玻璃表面 + 不支持时的回退
├── base.css            reset、排版、滚动条
├── layout.css          应用外壳
├── <域>.css            controls / browse / reader / overlays / drawer …
└── a11y.css            无障碍降级，必须排在最后
```

三条规矩：

- **`@import` 的顺序就是层叠顺序。** 新文件要插在正确的层叠位置上，
  不要图省事全堆到末尾 —— 同优先级谁在后面谁赢，堆到末尾等于悄悄改写覆盖关系。
- **`a11y.css` 永远在最后。** 它靠"后面的同优先级规则赢"来覆盖前面所有材质与动效。
- **不用 CSS Modules。** `scripts/verify-ui.mjs` 是按 `.card`、`.chapter-row`
  这些真实类名查 DOM 做断言的，类名一 hash 它就全查不到。命名沿用 BEM
  （`块__元素--修饰`），靠块名前缀避免撞车。

## 新功能开发流程

1. 先想清楚这块逻辑属于哪一层（UI / 状态 / 数据 / 服务）
2. 数据逻辑 → hook；UI 块 → 组件；页面只做编排
3. **写完当场检查文件大小**，超了就拆
4. **不要写完 700 行再回头拆** —— 那时候你已经不记得细节了

## 提交前自查

- [ ] 有没有超过 250 行的组件 / 300 行的工具文件
- [ ] 新加的 hook 是否只管一件事
- [ ] 页面组件里是否混了具体业务逻辑（应该都在 hook 里）
- [ ] 有没有重复的 JSX
- [ ] 改样式时有没有把新规则堆到文件末尾（层叠顺序会被悄悄改写）
- [ ] CSS 文件开头不要带 BOM：落到选择器前面那条规则就永不匹配，且不报错
- [ ] 有没有 `as never` / `as any` 之类的类型逃逸（通常是设计有问题）

## 反面案例（真实踩过的）

```ts
// ❌ 用类型逃逸绕过设计问题
const result = await getChapter(
  { meta: { id: pluginId } } as never,   // 塞了个假 Plugin
  slug,
  chapterId,
);

// ✅ 改成收真实类型
const result = await getChapter(plugin, slug, chapterId);
```

```ts
// ❌ 把每次渲染新建的对象当参数，它进不了依赖数组
useBookmarks(plugin, slug, chapterId, {
  scrollToPage: (p) => {},     // 每次都是新函数
  onJumpChapter: (id) => {},
});

// ✅ 需要这些逻辑就放到调用方（页面层），hook 只管数据
const bookmarks = useBookmarks(plugin, chapterId);
const jumpToBookmark = (b) => {
  /* 页面自己实现跳转 */
};
```

```ts
// ❌ 用 void 掩盖「参数用不到」的设计问题
function ReaderPanels({ slug, chapterId, ...props }) {
  // ...
  void slug;   // 这个参数其实不该收
}

// ✅ 改成分组结构体，只给需要的面板
interface Props {
  currentChapter: { slug: string; id: string };  // 只有目录面板需要
  mode: 'scroll' | 'paged';                      // 只有设置面板需要
}
```

```css
/* ❌ CSS 文件开头带 BOM。在文件头时浏览器会当 BOM 吃掉，一切正常；
   可一旦拆文件把它留在了正文里，它就变成选择器的第一个字符： */
:root { --glass-blur: 20px; }        /* 实际是 "\uFEFF :root" */
/* → 这条规则永不匹配，整套令牌静默失效。
   不报错、不告警、DevTools 里规则还在（228 条一条不少），
   只有 getPropertyValue 回来是空字符串。
   查出来靠的是读 selectorText 的 charCode，看见开头那个 65279。 */

/* ✅ CSS 一律不带 BOM。要判断部署结果也别用"看着对"，读计算值 */
```

## 现状（2026-10-15）

全部在上限内。最大的几个：

| 文件 | 行数 | 说明 |
|---|---|---|
| `sync/client.ts` | 298 | 贴着 300。设备身份与服务端地址（deviceId、显示名、endpoint、token）已拆到 `sync/device.ts`；状态条与配置弹层拆成 `SyncBar.tsx` / `SyncSheet.tsx` |
| `server/cache-store.mjs` | 252 | 图片缓存的盘上机制。配置在 `cache-config.mjs`、对外的脸在 `cache.mjs` |
| `pages/GlobalSearchPage.tsx` | 249 | 逼近 250。搜索历史已抽成 `useSearchHistory` |
| `pages/reader/ReaderPage.tsx` | 238 | 动作抽到 `useReaderActions`，副作用抽到 `useReaderEffects` |
| `site/validate.ts` | 220 | 从 types.ts 拆出：类型定义和校验规则各自演进 |

样式原先是单个 `src/styles.css`（1777 行，一个文件里塞了令牌、材质、外壳、
阅读器、弹层、无障碍降级），已按域拆成 `src/styles/` 下 14 个文件，
入口只留 `@import`。拆分是**按原行序切段**的，拼回去与拆分前逐字节一致，
层叠关系一点没动。最大的一段 `browse.css` 291 行。

拆分的判据始终是「一个文件有几件事」，不是行数。几个例子：
`site/types.ts` 377 行时超限，不是因为长，是因为里面同时有格式定义和校验规则；
`server/index.mjs` 362 行时也是 —— 它既有请求分发，又有同步端点、白名单、并发闸。
