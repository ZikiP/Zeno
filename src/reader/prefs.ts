/**
 * 阅读偏好
 *
 * 分两层，因为这两类东西的"归属"不一样：
 *
 *   - **单书级（BookPrefs）**：阅读方式、图片适配、翻页方向、单/双页、背景色、灰度。
 *     日漫要右起、条漫要竖向、有的书横条图就是要压扁看 —— 这些是**这本书**的性质，
 *     不该被另一本书的选择覆盖。每本书一条记录，跟着同步走（见 store/bookPrefs.ts）。
 *   - **设备级（DevicePrefs）**：亮度、屏幕常亮、翻页动画、读到底自动接下一章、画面增强。
 *     这是"我现在这台机器、这个环境"的事，
 *     跟着同步走会把手机的亮度设置搬到显示器上。翻页动画顺不顺滑取决于这台机器的屏幕和性能，
 *     所以它也在这一层，而且单独存一个键、不参与同步。
 *
 * `readerPrefs` 这个 localStorage 键是"除了翻页动画以外"的那份完整偏好，
 * 它同时充当"还没单独设过的书"的默认值：在任意一本书里改了显示项，会顺手把这份
 * 默认值也更新，于是以后新开的书继承你最新的习惯，而已经单独调过的书不受影响。
 * 翻页动画单独放在 `readerTurnAnim` 一个键里，正因为它是设备级的，而这份是要同步的。
 *
 * 阅读方式以前是一个全局同步键 `readerMode`，所有书共用一份；现在并进了
 * BookPrefs —— 同一本条漫和单行本混着看时，不该开一本就把另一本的翻法改掉。
 */
import { setLocalPref } from '@/sync/localPrefs';

/** 翻页方向：日漫习惯从右往左，韩漫/国漫从左往右 */
export type Direction = 'ltr' | 'rtl';
/** 分页方式 */
export type PageMode = 'single' | 'double';
/** 阅读方式：竖向滚动 / 左右翻页 */
export type ReaderMode = 'scroll' | 'paged';
/** 背景色（阅读器底色） */
export type BgColor = 'black' | 'dark' | 'sepia' | 'gray';
/**
 * 图片适配。四档与 Kavita / Tachiyomi / CDisplayEx 的口径一致。
 * 刻意不给"拉伸填满"：不保持比例会把人脸拉变形，漫画尤其不能忍。
 */
export type FitMode = 'width' | 'height' | 'screen' | 'original';
/**
 * 翻页动画。三档与微信读书 / 百度阅读 / 静读天下的口径一致（它们也是
 * 仿真翻页 / 左右滑动 / 无动画这几档，上下滚动那一档在我们这儿是另一种阅读模式）。
 */
export type TurnAnim = 'none' | 'slide' | 'flip';

/** 每本书各自记的偏好 */
export interface BookPrefs {
  /**
   * 阅读方式。条漫多用滚动、单行本多用翻页，所以它是**书**的性质而不是设备的。
   * 没有记录的老书记的是全局默认值（见 loadPrefs 的兼容分支）。
   */
  mode: ReaderMode;
  fit: FitMode;
  direction: Direction;
  pageMode: PageMode;
  bgColor: BgColor;
  grayscale: boolean;
  /**
   * 追漫：开着时，详情页一打开就把「未读的最近几章」的图片地址表交给服务端，
   * 由那台常开的机器去把原图铺到盘上。
   *
   * 记在这儿而不是 shelf 那一行：bookPrefs 参与同步，而且是以 {key, data, updatedAt}
   * 这个不透明 JSON  blob 的形式（transfer.ts / applyRemote.ts），加一项不用动
   * 服务端的列白名单和 merge 的那一列。shelf 加字段要改四处，还得给一个
   * 显示无关的东西动阅读进度的表。
   *
   * 可选而不是 DEFAULT_BOOK 里那条 false：没记过的老数据不该被写成"我选过不追"。
   */
  warm?: boolean;
}

/** 这台设备的偏好，不参与按书拆分 */
export interface DevicePrefs {
  /** 保持屏幕常亮 */
  keepAwake: boolean;
  /** 应用内亮度 0.3–1，覆盖系统亮度；null = 跟随系统 */
  brightness: number | null;
  /**
   * 翻页动画。存在自己那个键里，**不进同步**（见 TURN_KEY）：
   * 动画顺不顺滑取决于这台机器的屏幕和性能，把手机上选的那档搬到显示器上是灾难。
   */
  turnAnim: TurnAnim;
  /**
   * 沉浸式：一进阅读器就自动全屏。同样**不进同步**（见 IMMERSIVE_KEY）——
   * 全屏是这台设备的屏幕的事，而且手机撑得起、桌面浏览器多半直接被拒。
   */
  immersive: boolean;
  /**
   * 读到底自动接下一章。
   *
   * 跟翻页动画、沉浸式那两条不一样，它是**阅读习惯**而不是屏幕的事：
   * 在手机上养成了"滚到底就接着看"，换到平板也想要 —— 所以它跟着全局那份同步，
   * 而不是单独存一个本机键。
   *
   * 默认关：这是一个会自己改变"翻到章尾时发生什么"的行为，
   * 悄悄给老用户打开，等于让他们读到一半莫名跳章。
   *
   * 开着也不是"到底那一瞬间就飞走" —— 滚动模式先停在「本章完」那一屏，
   * 再给一次向下的意图才接下一章。理由见 useAutoNextChapter 那段。
   */
  autoNextChapter: boolean;
  /**
   * 上拉要攒多久（毫秒）。只在自动下一章开着时有意义。
   * 存毫秒不存秒：状态机按毫秒算，UI 换算成"1.5 秒"给人看，两头都不用再乘除一遍。
   */
  pullMs: number;
  /**
   * 画面增强（实验）：把页面图按屏幕实际显示的尺寸重采样再补一档高频。
   *
   * **设备级，而且单独存键、不参与同步** —— 和翻页动画同一个理由：
   * 这一档值不值开取决于这台机器的屏幕（DPR 越高越看得出来）和 CPU（每页约半秒），
   * 把手机上选的那档搬到别的设备上都是灾难。
   *
   * 默认关：它改变的是"你看到的画面"，悄悄给老用户换一套渲染不合适。
   */
  enhanceScreen: boolean;
}

/** 阅读器实际用的那份 = 单书 + 设备 */
export type ReaderPrefs = BookPrefs & DevicePrefs;

export const DEFAULT_BOOK: BookPrefs = {
  /* 改动前竖向滚动就是默认值，别让升级顺手换掉老用户的习惯 */
  mode: 'scroll',
  /*
   * 默认"适应屏幕"就是改动前的行为（object-fit: contain）。
   * 新加一档不该让老用户的阅读体验莫名变掉。
   */
  fit: 'screen',
  direction: 'rtl',
  pageMode: 'single',
  bgColor: 'black',
  grayscale: false,
};

export const DEFAULT_DEVICE: DevicePrefs = {
  keepAwake: true,
  brightness: null,
  turnAnim: 'flip',
  immersive: false,
  autoNextChapter: false,
  pullMs: 1500,
  enhanceScreen: false,
};

export const DEFAULT_PREFS: ReaderPrefs = { ...DEFAULT_BOOK, ...DEFAULT_DEVICE };

const KEY = 'readerPrefs';
const TURN_KEY = 'readerTurnAnim';
const IMMERSIVE_KEY = 'readerImmersive';
const ENHANCE_KEY = 'readerEnhance';
/** 旧版本单独存阅读方式的键。只读一次做迁移，不再写 */
const LEGACY_MODE_KEY = 'readerMode';

/**
 * 属于单书的那几个键。写单书记录时只带这些，别把亮度也塞进去。
 *
 * BookPrefs.warm 不在这一列里，是故意的：它是"这本要不要让机器替我铺图"，
 * 由详情页自己写（saveBookPrefs 一个 patch），阅读器既不读也不该顺手盖掉。
 */
export const BOOK_KEYS = ['mode', 'fit', 'direction', 'pageMode', 'bgColor', 'grayscale'] as const;

/**
 * 属于这台设备/这份全局的键。
 *
 * 列在这儿而不是在调用方一行行 `if ('xxx' in delta)`：每加一项都要多记一条，
 * 漏掉的那条不报错、也不提示，就是"开关点了、界面变了、刷新回去又没了"。
 * 自动下一章第一次就是这么写丢的。
 */
export const DEVICE_KEYS = [
  'keepAwake',
  'brightness',
  'turnAnim',
  'immersive',
  'autoNextChapter',
  'pullMs',
  'enhanceScreen',
] as const;

export function pickBook(p: Partial<ReaderPrefs>): Partial<BookPrefs> {
  const out: Partial<BookPrefs> = {};
  for (const k of BOOK_KEYS) if (k in p) (out as Record<string, unknown>)[k] = p[k];
  return out;
}

export function pickDevice(p: Partial<ReaderPrefs>): Partial<DevicePrefs> {
  const out: Partial<DevicePrefs> = {};
  for (const k of DEVICE_KEYS) if (k in p) (out as Record<string, unknown>)[k] = p[k];
  return out;
}

/**
 * 没在设置里选过时用哪档。
 *
 * 系统开了「减少动效」就退到平移 —— 折页那一下的透视和旋转才是让人难受的部分，
 * 横移一页还在。一旦选过，之后**完全按选的那档来**，系统偏好不再插手：
 * 上一版是样式表里无条件把折页改写成交叉淡入，结果就是「翻页莫名消失了」，
 * 界面上一句提示都没有，查半天。
 */
export function defaultTurnAnim(): TurnAnim {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'flip';
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'slide' : 'flip';
}

const TURN_VALUES: TurnAnim[] = ['none', 'slide', 'flip'];

/** 单独一个键，不跟着 readerPrefs 同步 */
export function loadTurnAnim(): TurnAnim {
  if (typeof localStorage === 'undefined') return defaultTurnAnim();
  const raw = localStorage.getItem(TURN_KEY);
  return TURN_VALUES.includes(raw as TurnAnim) ? (raw as TurnAnim) : defaultTurnAnim();
}

export function loadPrefs(): ReaderPrefs {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(KEY);
    // 与默认值合并，新增字段在旧版本数据上也能正常生效
    const blob = raw ? (JSON.parse(raw) as Partial<ReaderPrefs>) : {};
    /*
     * 旧版本把阅读方式单独存在 readerMode 里。第一次用新版时把它接过来，
     * 否则升级会把已经选好的翻页方式重置成默认的竖向滚动。
     * 放进 blob 之前，已经存过 mode 的 readerPrefs 仍然优先。
     */
    const legacyMode = localStorage.getItem(LEGACY_MODE_KEY);
    return {
      ...DEFAULT_PREFS,
      ...(legacyMode === 'paged' ? { mode: 'paged' as const } : {}),
      ...blob,
      turnAnim: loadTurnAnim(),
      immersive: loadImmersive(),
      enhanceScreen: loadEnhanceScreen(),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** 单独一个键，和 turnAnim 同理：这台设备的事，不跟着 readerPrefs 同步 */
export function loadImmersive(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(IMMERSIVE_KEY) === '1';
}

/** 同样单独一个键：吃不吃得下这半秒一页，是这台机器的事 */
export function loadEnhanceScreen(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(ENHANCE_KEY) === '1';
}

export function savePrefs(p: ReaderPrefs) {
  try {
    const { turnAnim, immersive, enhanceScreen, ...synced } = p;
    setLocalPref(KEY, JSON.stringify(synced));
    localStorage.setItem(TURN_KEY, turnAnim);
    localStorage.setItem(IMMERSIVE_KEY, immersive ? '1' : '0');
    localStorage.setItem(ENHANCE_KEY, enhanceScreen ? '1' : '0');
  } catch {
    /* 隐私模式下写不进去，忽略 */
  }
}

/** 背景色对应的实际 CSS 值 */
export const BG_VALUES: Record<BgColor, string> = {
  black: '#000000',
  dark: '#16181c',
  sepia: '#2b2620',
  gray: '#202124',
};

export const BG_LABELS: Record<BgColor, string> = {
  black: '纯黑',
  dark: '深灰',
  sepia: '护眼',
  gray: '中性',
};

export const FIT_LABELS: Record<FitMode, string> = {
  width: '适应宽度',
  height: '适应高度',
  screen: '适应屏幕',
  original: '原始尺寸',
};

export const TURN_LABELS: Record<TurnAnim, string> = {
  none: '无',
  slide: '平移',
  flip: '翻页',
};

/** 面板上那一行小字。说清楚各自适合什么，不然四档只是四个名词 */
export const FIT_HINTS: Record<FitMode, string> = {
  width: '撑满屏宽，上下超出就滚动 —— 条漫和手机最舒服',
  height: '一屏正好一张，两边可能留黑边',
  screen: '整张塞进屏幕，不裁不撑（默认）',
  original: '按图片原始像素显示，可横向滚动看细节',
};

/** 面板上那一行小字。说清楚各自适合什么，不然三档只是三个名词 */
export const TURN_HINTS: Record<TurnAnim, string> = {
  none: '直接换页，最跟手，低端设备也不卡',
  slide: '两页一起横推，像 Kindle 的左右滑动',
  flip: '绕书脊把旧页掀起来，最像翻纸（默认）',
};

/**
 * 亮度 + 灰度合成一条 CSS filter。
 * 都没开时返回 undefined，让 <img> 保持浏览器默认渲染而不是套一层空 filter
 * （套了会强制走合成层，长章节几十张图一起开反而更卡）。
 */
export function buildFilter(p: ReaderPrefs): string | undefined {
  const parts: string[] = [];
  if (p.brightness !== null) parts.push(`brightness(${p.brightness})`);
  if (p.grayscale) parts.push('grayscale(1)');
  return parts.length ? parts.join(' ') : undefined;
}
