/**
 * 界面字体的加载与应用
 *
 * 走 FontFace API 而不是注入 @font-face：字体端点要带 Bearer 令牌，
 * CSS 里的 url() 没法塞请求头。拉回来的二进制按内容 id 存进 IndexedDB，
 * 下次开机直接用，中文那种十几 MB 的包不必每开一页下载一遍。
 *
 * 应用方式是在 <html> 上写 --ui-font（含默认栈兜底），
 * base.css 的 body 用 var(--ui-font, 系统栈) 接住。
 */
import { db } from '@/store/db';
import { setLocalPref } from '@/sync/localPrefs';
import { fetchFontFile, getFonts, type FontFamily } from './api';

const KEY = 'uiFont';

/** 和 base.css 里 var() 的兜底档保持同一串 */
const DEFAULT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

export const readUiFont = (): string => localStorage.getItem(KEY) || '';

export function setUiFont(family: string): void {
  setLocalPref(KEY, family);
  void applyUiFont(true);
}

/** 已注册进 document.fonts 的 face id。同一个字体页内只注册一次 */
const registered = new Set<string>();

async function faceBytes(id: string): Promise<ArrayBuffer> {
  const d = await db();
  const hit = await d.get('fontFiles', id);
  if (hit) return hit.data;
  const data = await fetchFontFile(id);
  await d.put('fontFiles', { id, data, addedAt: Date.now() });
  return data;
}

/** 把一个族的全部字重/斜体注册好。设置页的预览也用它 —— 预览没加载的字体是假样 */
export async function loadFamily(fam: FontFamily): Promise<void> {
  for (const face of fam.faces) {
    if (registered.has(face.id)) continue;
    const data = await faceBytes(face.id);
    const ff = new FontFace(fam.family, data, { weight: String(face.weight), style: face.style });
    await ff.load();
    document.fonts.add(ff);
    registered.add(face.id);
  }
}

function paint(family: string): void {
  const el = document.documentElement;
  if (family) {
    // 字体名里的引号会截断 CSS 值，直接去掉
    el.style.setProperty('--ui-font', `"${family.replace(/"/g, '')}", ${DEFAULT_STACK}`);
  } else {
    el.style.removeProperty('--ui-font');
  }
}

let applied: string | null = null;
let running: Promise<void> | null = null;

/**
 * 把 localStorage 里选的字体落到页面上。
 *
 * 失败（服务端不可达、字体被删）就安静地留在系统字体上 —— 字体是锦上添花，
 * 不该把界面搞挂，也不该对着连不上的服务端反复重试刷请求。
 * 下一次同步落库（onDataChange）或设置页里的操作会再试。
 */
export function applyUiFont(force = false): Promise<void> {
  const want = readUiFont();
  if (!force && want === applied) return Promise.resolve();
  if (running) return running;

  running = (async () => {
    try {
      if (!want) {
        paint('');
        applied = '';
      } else {
        const { fonts } = await getFonts();
        const fam = fonts.find((f) => f.family.toLowerCase() === want.toLowerCase());
        if (fam) {
          await loadFamily(fam);
          paint(fam.family);
        } else {
          paint(''); // 服务端上这个字体没了：退回默认，而不是渲染成豆腐块
        }
        applied = want;
      }
    } catch {
      // 服务端不可达等：留在系统字体上。也要记 applied，
      // 否则末尾的补跑会立刻重试，变成对着连不上的服务端死循环刷请求。
      // 下一次 onDataChange（同步落库）或 force 会再试。
      applied = want;
    } finally {
      running = null;
    }
    // 跑这一趟期间用户又换了选择：补跑一次
    if (readUiFont() !== applied) void applyUiFont();
  })();
  return running;
}

/** 清掉服务端已不存在的字体缓存。设置页扫完列表顺手调一次 */
export async function pruneFontCache(fonts: FontFamily[]): Promise<void> {
  const alive = new Set(fonts.flatMap((f) => f.faces.map((x) => x.id)));
  const d = await db();
  for (const key of await d.getAllKeys('fontFiles')) {
    if (typeof key === 'string' && !alive.has(key)) await d.delete('fontFiles', key);
  }
}
