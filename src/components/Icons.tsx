/**
 * 图标 —— 统一走 lucide-react（ISC 许可，零依赖）。
 *
 * 这里只是一层映射：导出名和 props 与自绘时期完全一致，调用点不需要改。
 * 保留 strokeWidth 1.8（lucide 默认 2）以维持原有的视觉粗细。
 *
 * 换掉自绘的另一个原因是自绘里有几组图标彼此认不出来：IconExplore 曾经画成
 * 第二个放大镜（和 IconSearch 撞）、IconSettings 画成太阳（和 IconSun 只差一个
 * 半径）、IconBack 与 IconChevronLeft 的 path 逐字节相同。
 */
import {
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowRight,
  ArrowUpNarrowWide,
  ArrowUpDown,
  Bookmark,
  Check,
  CheckCheck,
  CircleDashed,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Compass,
  Download,
  LayoutGrid,
  Library,
  LibraryBig,
  List,
  MonitorSmartphone,
  Moon,
  NotebookText,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rows3,
  Search,
  Settings,
  Sun,
  Trash2,
  Upload,
  X,
  ZoomIn,
} from 'lucide-react';

type P = { size?: number; className?: string };

const SW = 1.8;

export const IconSearch = (p: P) => <Search strokeWidth={SW} {...p} />;
export const IconBack = (p: P) => <ArrowLeft strokeWidth={SW} {...p} />;
export const IconShelf = ({ size = 22, ...p }: P) => <Library size={size} strokeWidth={SW} {...p} />;
export const IconExplore = ({ size = 22, ...p }: P) => <Compass size={size} strokeWidth={SW} {...p} />;
export const IconCheck = ({ size = 18, ...p }: P) => <Check size={size} strokeWidth={SW} {...p} />;
export const IconPlus = (p: P) => <Plus strokeWidth={SW} {...p} />;
export const IconClose = (p: P) => <X strokeWidth={SW} {...p} />;
export const IconSettings = (p: P) => <Settings strokeWidth={SW} {...p} />;
export const IconGrid = (p: P) => <LayoutGrid strokeWidth={SW} {...p} />;
export const IconList = (p: P) => <List strokeWidth={SW} {...p} />;
/** 竖向滚动条 —— 阅读模式的「切到竖向滚动」用它，避免和章节目录的 IconList 撞 */
export const IconRows = (p: P) => <Rows3 strokeWidth={SW} {...p} />;
/** 书架的排序入口：上下两个箭头 = "顺序可调"，比再画一个列表图标好认 */
export const IconSort = (p: P) => <ArrowUpDown strokeWidth={SW} {...p} />;

/** 空状态插画 —— 比正文图标细一档，避免在 44px 下显得过重 */
export const IconEmpty = ({ size = 44, ...p }: P) => (
  <LibraryBig size={size} strokeWidth={1.2} {...p} />
);

export const IconSun = (p: P) => <Sun strokeWidth={SW} {...p} />;
export const IconMoon = (p: P) => <Moon strokeWidth={SW} {...p} />;
/** 「跟随系统」用显示器+手机，比单纯显示器更贴合语义 */
export const IconSystem = (p: P) => <MonitorSmartphone strokeWidth={SW} {...p} />;
export const IconDownload = ({ size = 18, ...p }: P) => <Download size={size} strokeWidth={SW} {...p} />;
export const IconExport = ({ size = 18, ...p }: P) => <Upload size={size} strokeWidth={SW} {...p} />;
export const IconChevronLeft = (p: P) => <ChevronLeft strokeWidth={SW} {...p} />;
export const IconChevronRight = (p: P) => <ChevronRight strokeWidth={SW} {...p} />;
export const IconEdit = ({ size = 15, ...p }: P) => <Pencil size={size} strokeWidth={SW} {...p} />;
export const IconTrash = ({ size = 15, ...p }: P) => <Trash2 size={size} strokeWidth={SW} {...p} />;
/**
 * 翻页方向。箭头指向「下一页在哪一边」——
 * 用 List / Rows 这类中性图标的话，图标和右边写的「右起 / 左起」对不上，
 * 等于没图标。
 */
export const IconDirection = ({ rtl = false, ...p }: P & { rtl?: boolean }) =>
  rtl ? <ArrowLeft strokeWidth={SW} {...p} /> : <ArrowRight strokeWidth={SW} {...p} />;
/** 双页显示 —— 左右两栏 */
export const IconDouble = (p: P) => <Columns2 strokeWidth={SW} {...p} />;
export const IconZoom = (p: P) => <ZoomIn strokeWidth={SW} {...p} />;
/** 书签与笔记面板 —— 和「收藏本页」的 IconBookmark 区分开：一个是看集合，一个是切当前页状态 */
export const IconNotes = (p: P) => <NotebookText strokeWidth={SW} {...p} />;

/** 书签。filled 时实心，表示已收藏 */
export const IconBookmark = ({
  size = 18,
  className,
  filled,
}: P & { filled?: boolean }) => (
  <Bookmark
    size={size}
    className={className}
    strokeWidth={SW}
    fill={filled ? 'currentColor' : 'none'}
  />
);

export const IconSync = ({ size = 18, ...p }: P) => <RefreshCw size={size} strokeWidth={SW} {...p} />;

/** 继续阅读 —— 三角形播放，没有比它更不容易认错的记号了 */
export const IconPlay = ({ size = 16, ...p }: P) => <Play size={size} strokeWidth={SW} {...p} />;

/**
 * 章节顺序。两个都用「窄/宽」箭头而不是单纯的上下箭头：
 * 上下箭头只表示方向，看不出是"从旧到新"还是"从新到旧"，
 * 而窄在上、宽在下正好对应列表由短到长地排下去。
 */
export const IconOrderAsc = (p: P) => <ArrowDownWideNarrow strokeWidth={SW} {...p} />;
export const IconOrderDesc = (p: P) => <ArrowUpNarrowWide strokeWidth={SW} {...p} />;

/**
 * 一键「这一章之前全标已读」。
 * 用双勾而不是 IconCheck：单勾已经表示「就是这一章」的状态，
 * 双勾才是成批的意思，两个记号不能混用。
 */
export const IconReadAll = ({ size = 15, ...p }: P) => <CheckCheck size={size} strokeWidth={SW} {...p} />;

/**
 * 一键「这一章之前取消已读」。和上面那对是一对反向动作，
 * 必须长得不一样 —— 手机上没有 hover，同一个图标靠 title 分方向等于没说。
 * 用虚线圈（"还没读"的空状态）而不是 ✕：那颗已经挂在关闭按钮上，
 * 而且这两个动作是改状态，不是删除。
 */
export const IconUnreadAll = ({ size = 15, ...p }: P) => <CircleDashed size={size} strokeWidth={SW} {...p} />;
