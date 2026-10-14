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

## 现状（2026-10-15）

全部在上限内。最大的几个：

| 文件 | 行数 | 说明 |
|---|---|---|
| `sync/client.ts` | 296 | 逼近 300。再加东西就该把"网络层"和"状态机"分开 |
| `pages/GlobalSearchPage.tsx` | 249 | 逼近 250。搜索历史已抽成 `useSearchHistory` |
| `pages/reader/ReaderPage.tsx` | 238 | 动作抽到 `useReaderActions`，副作用抽到 `useReaderEffects` |
| `site/validate.ts` | 220 | 从 types.ts 拆出：类型定义和校验规则各自演进 |

拆分的判据始终是「一个文件有几件事」，不是行数。几个例子：
`site/types.ts` 377 行时超限，不是因为长，是因为里面同时有格式定义和校验规则；
`server/index.mjs` 362 行时也是 —— 它既有请求分发，又有同步端点、白名单、并发闸。
