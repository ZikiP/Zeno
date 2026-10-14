/**
 * 阅读偏好
 *
 * 独立成文件是因为这些设置会同时被阅读器和设置面板用到，
 * 且需要跨会话持久化。
 */

/** 翻页方向：日漫习惯从右往左，韩漫/国漫从左往右 */
export type Direction = 'ltr' | 'rtl';
/** 分页方式 */
export type PageMode = 'single' | 'double';
/** 背景色（阅读器底色） */
export type BgColor = 'black' | 'dark' | 'sepia' | 'gray';

export interface ReaderPrefs {
  direction: Direction;
  pageMode: PageMode;
  /** 保持屏幕常亮 */
  keepAwake: boolean;
  /** 应用内亮度 0.3–1，覆盖系统亮度；null = 跟随系统 */
  brightness: number | null;
  bgColor: BgColor;
  /** 灰度显示，省流量也护眼 */
  grayscale: boolean;
}

export const DEFAULT_PREFS: ReaderPrefs = {
  direction: 'rtl',
  pageMode: 'single',
  keepAwake: true,
  brightness: null,
  bgColor: 'black',
  grayscale: false,
};

const KEY = 'readerPrefs';

export function loadPrefs(): ReaderPrefs {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    // 与默认值合并，新增字段在旧版本数据上也能正常生效
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ReaderPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: ReaderPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
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
