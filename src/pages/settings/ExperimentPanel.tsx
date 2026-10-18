import { usePrefs } from '@/pages/reader/usePrefs';
import { Row, Section } from '@/components/reader/PrefRows';
import { IconZoom } from '@/components/Icons';

/**
 * 设置 → 实验：还没定型的开关
 *
 * 单独一栏而不是塞进「阅读」，是因为这些东西的性质和阅读偏好不一样：
 * 阅读偏好是"我习惯怎么看书"，会一直留在这儿；实验项是"这个做法值不值，
 * 还在量"，随时可能整条删掉。混在一栏里，删的时候连累旁边的东西，
 * 用户也分不清哪条是稳定的。
 *
 * 这一栏里的项**都是设备级、单独存键、不参与同步** —— 吃不吃得下取决于
 * 这台机器的屏幕和性能，把手机上开的档搬到显示器上多半没法看。
 */
export default function ExperimentPanel() {
  const prefs = usePrefs(null);

  return (
    <>
      <p className="settings-note">
        这一栏是<em>还在试</em>的功能：效果不满意随时关掉，也可能哪天整条改掉或删掉。
        它们都是这台设备自己的事，只存在本机、不参与同步。
      </p>

      <Section title="画面">
        <Row
          icon={<IconZoom size={18} />}
          label="画面增强"
          hint="页面图比屏幕窄时（手机和高倍屏上最常见），改由本机按显示尺寸重新采样并补一档高频，线条和小字更利落。每张图晚约半秒出，费一点电；源图本来就够宽时不会动它。"
          control={<div className={`switch${prefs.value.enhanceScreen ? ' on' : ''}`} />}
          onClick={() => prefs.patch({ enhanceScreen: !prefs.value.enhanceScreen })}
        />
      </Section>
    </>
  );
}
