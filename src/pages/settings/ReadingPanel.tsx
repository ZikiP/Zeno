import {
  BG_LABELS,
  BG_VALUES,
  FIT_HINTS,
  FIT_LABELS,
  TURN_HINTS,
  TURN_LABELS,
  type BgColor,
  type FitMode,
  type TurnAnim,
} from '@/reader/prefs';
import { usePrefs } from '@/pages/reader/usePrefs';
import { Row, Section, Seg } from '@/components/reader/PrefRows';
import { IconChevronLeft, IconDirection, IconDouble, IconExpand, IconMoon, IconSun, IconZoom } from '@/components/Icons';
import { setLocalPref } from '@/sync/localPrefs';
import { useEffect, useState } from 'react';

/**
 * 设置 → 阅读：全局那一份阅读偏好
 *
 * 和阅读器里那个面板是**同一套 DOM**（PrefRows），管的层不一样：
 * 面板改的是"这一本书"（顺带把全局默认也更新），这里只改全局那一份 ——
 * 所以在书架上点进一本调过的书，它还是自己的设置，不会被这儿盖掉。
 * 这句话必须在界面上说出来，不然人会觉得设置页说了不算。
 *
 * 翻页动画、沉浸式是那台设备的事，单独存键、不参与同步（见 reader/prefs.ts）；
 * 亮度、常亮、自动下一章跟着 readerPrefs 同步。
 */

/** 阅读方式的全局默认。和阅读器里同一把键，改这儿就等于改"新书怎么开" */
const MODE_KEY = 'readerMode';
type ReaderMode = 'scroll' | 'paged';

export default function ReadingPanel() {
  const prefs = usePrefs(null);
  const [mode, setMode] = useState<ReaderMode>(() =>
    localStorage.getItem(MODE_KEY) === 'paged' ? 'paged' : 'scroll',
  );

  const pickMode = (m: ReaderMode) => {
    setMode(m);
    // 走 setLocalPref 而不是裸 localStorage：那是同步键，少了 __at 时间戳
    // 下一次拉取就会被别处的旧值盖回来
    setLocalPref(MODE_KEY, m);
  };

  /*
   * 这栏是设置页的一个 tab，切走再切回来组件会重挂，重挂时从键里读一次；
   * 但用户也可能在阅读器面板里改这一档，那不会让这栏重挂 ——
   * 所以回到前台时再读一次。监听器必须是同一个引用，否则移除不掉，
   * 每次进这栏都会多挂一个。
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        setMode(localStorage.getItem(MODE_KEY) === 'paged' ? 'paged' : 'scroll');
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const brightness = Math.round((prefs.value.brightness ?? 1) * 100);
  const fitLabels = Object.fromEntries(
    (Object.keys(FIT_LABELS) as FitMode[]).map((f) => [f, FIT_LABELS[f].replace('适应', '')]),
  ) as Record<FitMode, string>;

  return (
    <>
      <p className="settings-note">
        这一栏是<em>全局默认</em>：以后新打开的书按这儿走。
        已经在阅读器的「阅读设置」里单独调过的书<em>各自记一份</em>，不会被这儿盖掉。
        <br />
        亮度、常亮、自动下一章跟着多端同步；翻页动画和沉浸式是这台设备自己的事，
        把手机上选的那档搬到显示器上多半没法看。
      </p>

      <Section title="阅读方式">
        <Seg
          values={['scroll', 'paged'] as const}
          labels={{ scroll: '竖向滚动', paged: '左右翻页' }}
          hints={{
            scroll: '像刷网页一样连续下滑。适合手机、长章节。',
            paged: '一屏一页，点击左右区域翻页。适合平板、显示器。',
          }}
          current={mode}
          onPick={pickMode}
        />
        <Row
          icon={<IconChevronLeft size={18} />}
          label="读到底自动接下一章"
          hint="滚到章末先停在「本章完」那一屏，上一章的结尾留在眼前；再往下推一下（或点那一行）才接下一章。翻页模式则是在最后一页再往前翻一次即接。"
          control={<div className={`switch${prefs.value.autoNextChapter ? ' on' : ''}`} />}
          onClick={() => prefs.patch({ autoNextChapter: !prefs.value.autoNextChapter })}
        />
      </Section>

      <Section title="图片适配">
        <Seg
          values={Object.keys(FIT_LABELS) as FitMode[]}
          labels={fitLabels}
          hints={FIT_HINTS}
          current={prefs.value.fit}
          onPick={(fit) => prefs.patch({ fit })}
        />
      </Section>

      <Section title="翻页">
        <Row
          icon={<IconDirection size={18} rtl={prefs.value.direction === 'rtl'} />}
          label="翻页方向"
          hint={prefs.value.direction === 'rtl' ? '右起翻页，日漫习惯' : '左起翻页，国漫/韩漫习惯'}
          value={prefs.value.direction === 'rtl' ? '右起' : '左起'}
          onClick={() =>
            prefs.patch({ direction: prefs.value.direction === 'rtl' ? 'ltr' : 'rtl' })
          }
        />
        <Row
          icon={<IconDouble size={18} />}
          label="双页显示"
          hint={prefs.value.pageMode === 'double' ? '横屏一屏两页，建议配合横屏' : '一屏一页'}
          value={prefs.value.pageMode === 'double' ? '开' : '关'}
          onClick={() =>
            prefs.patch({ pageMode: prefs.value.pageMode === 'single' ? 'double' : 'single' })
          }
        />
        <div className="prefs-sublabel">翻页动画</div>
        <Seg
          values={Object.keys(TURN_LABELS) as TurnAnim[]}
          labels={TURN_LABELS}
          hints={TURN_HINTS}
          current={prefs.value.turnAnim}
          onPick={(turnAnim) => prefs.patch({ turnAnim })}
        />
      </Section>

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
                className={`swatch${prefs.value.bgColor === c ? ' on' : ''}`}
                style={{ background: BG_VALUES[c] }}
                onClick={() => prefs.patch({ bgColor: c })}
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
              {prefs.value.brightness === null ? '跟随系统' : `${brightness}%`}
            </div>
          </div>
          <div className="slider-wrap">
            <input
              type="range"
              min={30}
              max={100}
              value={brightness}
              onChange={(e) => prefs.patch({ brightness: Number(e.target.value) / 100 })}
            />
            {prefs.value.brightness !== null && (
              <button className="slider-reset" onClick={() => prefs.patch({ brightness: null })}>
                还原
              </button>
            )}
          </div>
        </div>

        <Row
          icon={<IconZoom size={18} />}
          label="灰度显示"
          hint="去掉颜色，省流量"
          control={<div className={`switch${prefs.value.grayscale ? ' on' : ''}`} />}
          onClick={() => prefs.patch({ grayscale: !prefs.value.grayscale })}
        />
        <Row
          icon={<IconMoon size={18} />}
          label="保持屏幕常亮"
          hint="阅读时不自动锁屏，省得反复点亮"
          control={<div className={`switch${prefs.value.keepAwake ? ' on' : ''}`} />}
          onClick={() => prefs.patch({ keepAwake: !prefs.value.keepAwake })}
        />
        <Row
          icon={<IconExpand size={18} />}
          label="沉浸式阅读"
          hint="一进阅读器就自动全屏。iPhone 的 Safari 没有网页全屏接口，请改用浏览器菜单的「添加到主屏幕」"
          control={<div className={`switch${prefs.value.immersive ? ' on' : ''}`} />}
          onClick={() => prefs.patch({ immersive: !prefs.value.immersive })}
        />
      </Section>
    </>
  );
}
