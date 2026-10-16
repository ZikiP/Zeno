/**
 * 界面字体的常驻应用
 *
 * 和 useTheme 同一形状：开机应用一次，之后每次同步落库（别处改了选择）
 * 重新读一遍。applyUiFont 内部比对过 applied，多订阅、多触发都是空转。
 */
import { useEffect } from 'react';
import { onDataChange } from '@/store/dataEvents';
import { applyUiFont } from './apply';

export function useUiFont(): void {
  useEffect(() => {
    void applyUiFont(true);
    return onDataChange(() => void applyUiFont());
  }, []);
}
