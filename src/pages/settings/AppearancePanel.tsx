import { useState } from 'react';
import { useTheme, THEMES } from '@/hooks/useTheme';
import { IconMoon, IconSun, IconSystem } from '@/components/Icons';
import { getShelfCols, setShelfCols, SHELF_COLS } from '@/store/shelfOrder';
import { sync } from '@/sync/client';

const icons = {
  light: <IconSun size={18} />,
  dark: <IconMoon size={18} />,
  system: <IconSystem size={18} />,
};

/** 加减一档。到边界就按不动而不是消失 —— 消失会让"已经到底了"看不出来 */
function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="settings-row settings-row--still">
      <span className="settings-row__name">{label}</span>
      <div className="stepper" role="group" aria-label={label}>
        <button
          type="button"
          className="stepper__btn"
          aria-label={`${label} 减一`}
          disabled={value <= min}
          onClick={() => onChange(value - 1)}
        >
          −
        </button>
        <span className="stepper__value" aria-live="polite">
          {value}
        </span>
        <button
          type="button"
          className="stepper__btn"
          aria-label={`${label} 加一`}
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

/**
 * 外观
 *
 * 只管这台设备怎么看。亮度和翻页方式那些是**这本书/这个阅读器**的偏好，
 * 在阅读器里的「阅读设置」，两边不该混在一栏：前者换设备也想跟着走，
 * 后者跟着同步走会把手电筒亮度带到电脑上。
 *
 * 书架格子数是例外：它跟着同步走，但**存的是两个数**——
 * 手机和显示器各取所需，于是"我把它设成 3 列"这件事不用每台设备重说一遍。
 */
export default function AppearancePanel() {
  const { mode, setTheme } = useTheme();
  const [cols, setCols] = useState(getShelfCols);

  const change = (next: { sm: number; lg: number }) => {
    setCols(next);
    setShelfCols(next.sm, next.lg);
    void sync.sync();
  };

  return (
    <>
      <p className="settings-note">
        浅色、深色，或跟着设备的自动切换走。这台设备的选择，不参与同步。
      </p>

      <div className="theme-picker">
        {THEMES.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`theme-option${mode === t.key ? ' on' : ''}`}
            aria-pressed={mode === t.key}
            onClick={() => setTheme(t.key)}
          >
            <span className="theme-option__icon">{icons[t.key]}</span>
            <span className="theme-option__label">{t.label}</span>
            <span className="theme-option__hint">{t.hint}</span>
          </button>
        ))}
      </div>

      <h3 className="settings-h">书架格子数</h3>
      <p className="settings-note">
        按屏幕宽度分别定：窄于 700px 用小屏那一档，宽了用大屏那一档。
        两个数会同步给你的其他设备，换设备时按它自己的宽度取用。
      </p>
      <div className="settings-rows">
        <Stepper
          label="小屏（手机）"
          value={cols.sm}
          min={SHELF_COLS.sm.min}
          max={SHELF_COLS.sm.max}
          onChange={(sm) => change({ ...cols, sm })}
        />
        <Stepper
          label="大屏（平板 / 电脑）"
          value={cols.lg}
          min={SHELF_COLS.lg.min}
          max={SHELF_COLS.lg.max}
          onChange={(lg) => change({ ...cols, lg })}
        />
      </div>
    </>
  );
}
