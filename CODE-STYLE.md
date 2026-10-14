# 编码规范

## 文件大小

| 类型 | 上限 | 说明 |
|---|---|---|
| 组件文件 | 250 行 | 超了就拆 |
| 工具/服务文件 | 300 行 | 超了就拆 |
| 类型定义 | 不限 | 纯类型没有复杂度 |

**判断标准不是行数，是"一个文件有几件事"。** 一个文件只做一件事，
哪怕它有 300 行（内容都是声明）也比 150 行的混合文件好维护。

## 拆分原则

按**职责**拆，不按行数硬切：

```
ReaderPage.tsx 772 行 拆成：
├── pages/reader/ReaderPage.tsx        主组件，只做编排
├── pages/reader/useChapterLoader.ts   章节加载 hook
├── pages/reader/useReaderHotkeys.ts   键盘与手势
├── pages/reader/useBookmarkMarks.ts  书签标记
├── components/reader/PagedView.tsx   分页模式渲染
├── components/reader/ScrollView.tsx  滚动模式渲染
├── components/reader/ReaderBar.tsx   顶部工具栏
├── components/reader/ReaderPrefsSheet.tsx 设置面板
└── components/reader/ZoomView.tsx    放大视图
```

## 什么该抽成组件

| 信号 | 该抽 |
|---|---|
| 一段 JSX 超过 30 行 | 抽组件 |
| 同一个 JSX 块在两处出现 | 抽组件 |
| 有一组相关的 state + 操作逻辑 | 抽 hook |
| 渲染分支超过 3 个 | 每个分支一个组件 |

## 什么不该抽

- 只用一次但**确实独立**的逻辑 → 抽（例：`PrefsSheet` 只用一次，但它是独立 UI）
- 纯粹为了"显得模块化"而拆 → 不要拆

**拆的标准是"改这块时会不会影响别的"。** 会，就拆；不会，就别动。

## Hook 的边界

- 一个 hook 管一件事（加载 / 键盘 / 书签 / 主题，不要混）
- hook 返回值不超过 6 个，超过就该合并或再拆
- hook 之间不互相调用，除了极小的工具 hook

## 导入路径

- 组件放 `src/components/<域>/`，域内再分文件
- 页面私有组件放 `src/pages/<页>/`，不要污染公共 components
- 只有**两个以上页面都在用**的才进 `src/components/`

## 新功能开发流程

1. 先想清楚这块逻辑属于哪一层（UI / 状态 / 数据 / 服务）
2. 数据逻辑 → hook；UI 块 → 组件；页面只做编排
3. 写完检查文件大小，超了就当场拆，别攒着
4. **不要写完 700 行再回头拆**，那时候你已经不记得细节了

## 提交前自查

- [ ] 有没有超过 250 行的组件 / 300 行的工具文件
- [ ] 新加的 hook 是否只管一件事
- [ ] 页面组件里是否混了具体业务逻辑（应该都在 hook 里）
- [ ] 有没有重复的 JSX
