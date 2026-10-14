/** 内联 SVG 图标 —— 统一 24x24 视框，stroke 跟随 currentColor */
type P = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const IconSearch = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const IconBack = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);

export const IconShelf = ({ size = 22 }: P) => (
  <svg {...base(size)}>
    <path d="M4 5v14M9 5v14" />
    <path d="M13.5 5.5l4.5 13" />
  </svg>
);

export const IconExplore = ({ size = 22 }: P) => (
  <svg {...base(size)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m16.5 16.5 4 4" />
  </svg>
);

export const IconCheck = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="m5 13 4 4L19 7" />
  </svg>
);

export const IconPlus = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconClose = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconSettings = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10l1.4 1.4M5.6 18.4L7 17m10-10l1.4-1.4" />
  </svg>
);

export const IconGrid = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </svg>
);

export const IconList = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);

export const IconEmpty = ({ size = 44 }: P) => (
  <svg {...base(size)} strokeWidth={1.2}>
    <path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2z" />
    <path d="M8 3v18" />
    <path d="M12 9h4M12 13h4" />
  </svg>
);

export const IconSun = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);

export const IconMoon = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
  </svg>
);

/** 显示器图标 —— 表示「跟随系统」 */
export const IconSystem = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

/** 下载 —— 导入 */
export const IconDownload = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M12 3v12m0 0l-4-4m4 4l4-4" />
    <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
  </svg>
);

/** 上传箭头 —— 导出 */
export const IconExport = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M12 15V3m0 0l-4 4m4-4l4 4" />
    <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
  </svg>
);

export const IconChevronLeft = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);

export const IconChevronRight = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);

/** 双页 —— 两个并排的方框 */
export const IconDouble = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <rect x="2" y="5" width="8.5" height="14" rx="1.5" />
    <rect x="13.5" y="5" width="8.5" height="14" rx="1.5" />
  </svg>
);

/** 放大镜 */
export const IconZoom = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L21 21M8 10.5h5M10.5 8v5" />
  </svg>
);
