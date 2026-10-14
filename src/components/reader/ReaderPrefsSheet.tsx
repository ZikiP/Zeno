import {
  BG_LABELS,
  BG_VALUES,
  type BgColor,
  type ReaderPrefs,
} from '@/reader/prefs';
import { HOTKEY_HELP } from '@/pages/reader/useReaderHotkeys';
import {
  IconDouble,
  IconDirection,
  IconMoon,
  IconSun,
  IconZoom,
  IconBack,
} from '@/components/Icons';
import { Sheet } from '@/components/UI';

export type ReaderMode = 'scroll' | 'paged';

/**
 * 阅读设置面板
 *
 * 独立成文件是因为它自成一块 UI（200+ 行 JSX），
 * 且逻辑上与阅读流程无关 —— 改它不该动阅读器主组件。
 */
export default function ReaderPrefsSheet({
  prefs,
  mode,
  fromCache,
  onChange,
  onMode,
  onClose,
}: {
  prefs: ReaderPrefs;
  mode: ReaderMode;
  fromCache: boolean;
  onChange: (patch: Partial<ReaderPrefs>) => void;
  onMode: (m: ReaderMode) => void;
  onClose: () => void;
}) {
  const brightness = Math.round((prefs.brightness ?? 1) * 100);

  return (
    <Sheet title="阅读设置" onClose={onClose}>
      {/* ── 阅读方式 ── */}
      <Section title="阅读方式">
        <div className="seg">
          {(['scroll', 'paged'] as const).map((m) => (
            <button
              key={m}
              className={`seg__item${mode === m ? ' on' : ''}`}
              onClick={() => onMode(m)}
            >
              {m === 'scroll' ? '竖向滚动' : '左右翻页'}
            </button>
          ))}
        </div>
        <div className="prefs-hint">
          {mode === 'scroll'
            ? '像刷网页一样连续下滑。适合手机、长章节。'
            : '一屏一页，点击左右区域翻页。适合平板、显示器。'}
        </div>
      </Section>

      {/* ── 翻页设置：只在分页模式有意义 ── */}
      {mode === 'paged' && (
        <Section title="翻页设置">
          <Row
            icon={<IconDirection size={18} rtl={prefs.direction === 'rtl'} />}
            label="翻页方向"
            hint={
              prefs.direction === 'rtl'
                ? '右起翻页，日漫习惯'
                : '左起翻页，国漫/韩漫习惯'
            }
            value={prefs.direction === 'rtl' ? '右起' : '左起'}
            onClick={() => onChange({ direction: prefs.direction === 'rtl' ? 'ltr' : 'rtl' })}
          />
          <Row
            icon={<IconDouble size={18} />}
            label="双页显示"
            hint={prefs.pageMode === 'double' ? '横屏一屏两页，建议配合横屏' : '一屏一页'}
            value={prefs.pageMode === 'double' ? '开' : '关'}
            onClick={() => onChange({ pageMode: prefs.pageMode === 'single' ? 'double' : 'single' })}
          />
        </Section>
      )}

      {/* ── 显示 ── */}
      <Section title="显示">
        <div className="pref-row pref-row--static">
          <div className="pref-row__text">
            <div className="pref-row__label">背景色</div>
            <div className="pref-row__hint">纯黑最省电，护眼色适合长时间</div>
          </div>
          <div className="swatches">
            {(Object.keys(BG_LABELS) as BgColor[]).map((c) => (
              <button
                key={c}
                className={`swatch${prefs.bgColor === c ? ' on' : ''}`}
                style={{ background: BG_VALUES[c] }}
                onClick={() => onChange({ bgColor: c })}
                title={BG_LABELS[c]}
                aria-label={BG_LABELS[c]}
              />
            ))}
          </div>
        </div>

        <div className="pref-row pref-row--static">
          <IconSun size={18} />
          <div className="pref-row__text">
            <div className="pref-row__label">亮度</div>
            <div className="pref-row__hint">
              {prefs.brightness === null ? '跟随系统' : `${brightness}%`}
            </div>
          </div>
          <div className="slider-wrap">
            <input
              type="range"
              min={30}
              max={100}
              value={brightness}
              onChange={(e) => onChange({ brightness: Number(e.target.value) / 100 })}
            />
            {prefs.brightness !== null && (
              <button className="slider-reset" onClick={() => onChange({ brightness: null })}>
                还原
              </button>
            )}
          </div>
        </div>

        <Row
          icon={<IconZoom size={18} />}
          label="灰度显示"
          hint="去掉颜色，省流量"
          control={
            <div className={`switch${prefs.grayscale ? ' on' : ''}`} />
          }
          onClick={() => onChange({ grayscale: !prefs.grayscale })}
        />

        <Row
          icon={<IconMoon size={18} />}
          label="保持屏幕常亮"
          hint="阅读时不自动锁屏，省得反复点亮"
          control={<div className={`switch${prefs.keepAwake ? ' on' : ''}`} />}
          onClick={() => onChange({ keepAwake: !prefs.keepAwake })}
        />
      </Section>

      {/* ── 用法 ── */}
      <Section title="用法">
        <Row
          icon={<IconZoom size={18} />}
          label="长按或双击图片"
          hint="放大查看细节，点击任意处关闭"
        />
        <Row
          icon={<IconBack size={18} />}
          label="离线缓存"
          hint={fromCache ? '当前章节来自本机缓存' : '打开过的章节会自动缓存，断网可读'}
        />

        <div className="pref-row pref-row--static" style={{ display: 'block' }}>
          <div className="pref-row__label" style={{ marginBottom: 8 }}>
            电脑端快捷键
          </div>
          <div className="hotkeys">
            {HOTKEY_HELP.map((h) => (
              <div key={h.keys} className="hotkeys__row">
                <kbd>{h.keys}</kbd>
                <span>{h.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </Section>
    </Sheet>
  );
}

/* ── 内部小组件 ─────────────────────────────────── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="prefs-section">
      <div className="prefs-section__title">{title}</div>
      {children}
    </div>
  );
}

function Row({
  icon,
  label,
  hint,
  value,
  control,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  hint?: string;
  value?: string;
  control?: React.ReactNode;
  /** 有则整行可点 */
  onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={`pref-row${onClick ? '' : ' pref-row--static'}`}
      {...(onClick ? { onClick } : {})}
    >
      {icon}
      <div className="pref-row__text">
        <div className="pref-row__label">{label}</div>
        {hint && <div className="pref-row__hint">{hint}</div>}
      </div>
      {value && <span className="pref-row__value">{value}</span>}
      {control}
    </Tag>
  );
}
