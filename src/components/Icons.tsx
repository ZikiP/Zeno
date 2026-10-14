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
  ArrowLeft,
  Bookmark,
  Check,
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
  Plus,
  RefreshCw,
  Rows3,
  Search,
  Settings,
  Sun,
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
/** 双页显示 —— 左右两栏 */
export const IconDouble = (p: P) => <Columns2 strokeWidth={SW} {...p} />;
export const IconZoom = (p: P) => <ZoomIn strokeWidth={SW} {...p} />;

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
