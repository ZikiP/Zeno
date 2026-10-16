import { serverCall, serverFetchBinary } from '@/sync/serverCall';

/**
 * 服务端字体接口的客户端
 *
 * 目录路径不进 SYNCED_KEYS（那是服务端那台机器的磁盘路径，和缓存目录同理）；
 * 但「选了哪个字体」（uiFont 键）跟着账号同步 —— 字体文件由这个服务端供给，
 * 任何设备都拉得到，选择没必要每台重说一遍。
 */

export interface FontFaceInfo {
  id: string;
  subfamily: string;
  weight: number;
  style: 'normal' | 'italic';
}

export interface FontFamily {
  family: string;
  faces: FontFaceInfo[];
}

export interface FontsStatus {
  dir: string;
  defaultDir: string;
  fonts: FontFamily[];
  /** 个别包坏了之类的提示，不致命 */
  warning: string | null;
}

export const getFonts = () => serverCall<FontsStatus>('/api/fonts');

export const saveFontDir = (dir: string) =>
  serverCall<FontsStatus>('/api/fonts/config', { method: 'POST', body: JSON.stringify({ dir }) });

export const rescanFonts = () =>
  serverCall<FontsStatus>('/api/fonts/rescan', { method: 'POST', body: '{}' }, 30_000);

/** 拉字体二进制。一包可能十几 MB，超时给到 60 秒 */
export const fetchFontFile = (id: string) => serverFetchBinary(`/api/fonts/file?id=${encodeURIComponent(id)}`);
