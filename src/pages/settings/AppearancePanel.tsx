import { useTheme, THEMES } from '@/hooks/useTheme';
import { IconMoon, IconSun, IconSystem } from '@/components/Icons';

const icons = {
  light: <IconSun size={18} />,
  dark: <IconMoon size={18} />,
  system: <IconSystem size={18} />,
};

/**
 * 外观
 *
 * 只管这台设备怎么看。亮度和翻页方式那些是**这本书/这个阅读器**的偏好，
 * 在阅读器里的「阅读设置」，两边不该混在一栏：前者换设备也想跟着走，
 * 后者跟着同步走会把手电筒亮度带到电脑上。
 */
export default function AppearancePanel() {
  const { mode, setTheme } = useTheme();

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
    </>
  );
}
