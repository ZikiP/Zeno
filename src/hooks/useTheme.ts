/**
 * 主题：浅色 / 深色 / 跟随系统
 *
 * 实现方式：
 * - 用户选「浅色」或「深色」→ 在 <html> 上写 data-theme，CSS 变量直接生效
 * - 选「跟随系统」→ 移除 data-theme，由 CSS 的 prefers-color-scheme 决定
 * 这样「跟随」能实时响应系统切换，不要 JS 监听。
 */
import { useCallback, useEffect, useState } from 'react';
import { onDataChange } from '@/store/dataEvents';
import { setLocalPref } from '@/sync/localPrefs';

export type ThemeMode = 'light' | 'dark' | 'system';

const KEY = 'themeMode';

function readMode(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'system';
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

function apply(mode: ThemeMode) {
  const el = document.documentElement;
  if (mode === 'system') {
    el.removeAttribute('data-theme');
  } else {
    el.setAttribute('data-theme', mode);
  }
  // 让浏览器 UI（滚动条、表单控件）也跟着变
  const resolved =
    mode === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : mode;
  el.style.colorScheme = resolved;
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readMode);

  useEffect(() => {
    apply(mode);
  }, [mode]);

  // 跟随系统时，监听系统主题变化实时响应
  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  /*
   * 同步会把别处的主题设置拉回来写进 localStorage。
   * 不重新读的话，手机上刚同步完还得刷新页面才生效。
   *
   * 这个 hook 会被多个组件调用（App 层、设置页、设置面板），
   * 各自都会订阅 —— 幂等，多订阅几次没有副作用。
   */
  useEffect(() => {
    return onDataChange(() => {
      const next = readMode();
      setMode((cur) => (cur === next ? cur : next));
    });
  }, []);

  const setTheme = useCallback((m: ThemeMode) => {
    setLocalPref(KEY, m);
    setMode(m);
  }, []);

  /** 当前实际生效的是浅色还是深色（跟随系统时解析系统偏好） */
  const resolved: 'light' | 'dark' =
    mode === 'system'
      ? typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : mode;

  return { mode, resolved, setTheme };
}

export const THEMES: { key: ThemeMode; label: string; hint: string }[] = [
  { key: 'light', label: '浅色', hint: '白天与明亮环境' },
  { key: 'dark', label: '深色', hint: '夜间阅读，护眼省电' },
  { key: 'system', label: '跟随系统', hint: '随设备自动切换深浅色' },
];
