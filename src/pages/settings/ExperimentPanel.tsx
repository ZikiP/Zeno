import { useEffect, useState } from 'react';
import { usePrefs } from '@/pages/reader/usePrefs';
import { Row, Section } from '@/components/reader/PrefRows';
import { IconZoom } from '@/components/Icons';
import { diskStatus, requestPersist } from '@/reader/enhanceDisk';

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
  const [disk, setDisk] = useState<Awaited<ReturnType<typeof diskStatus>> | undefined>(undefined);

  /*
   * 这两个数（存了几张、浏览器给不给持久存储）别处看不到，而它们恰好是
   * "前一阵还好好的，今天怎么每章都要等"的答案：要么超上限被砍了，
   * 要么没拿到持久存储、被浏览器在配额紧时整桶清了。
   */
  useEffect(() => {
    let dropped = false;
    void diskStatus().then(
      (s) => !dropped && setDisk(s),
      () => !dropped && setDisk(null),
    );
    return () => {
      dropped = true;
    };
  }, []);

  const on = prefs.value.enhanceScreen;
  /* 三种状态各说各的话：正在问 / 拿不到存储 / 拿到了。别在还没问出来时就报"不报状态"。 */
  const usedHint =
    disk === undefined
      ? '正在问本机那块存储…'
      : disk === null
        ? '拿不到那块存储（无痕窗口、或太老的浏览器）。这一档还能用，只是每次重读都要重新算。'
        : `本机算过的增强图一共攒到 ${disk.max} 张左右就砍最早那批：重读最近十来章不至于从头算，被砍掉的下次要重算一次。` +
          (disk.persisted === false
            ? ' 这台浏览器目前没给持久存储：配额吃紧时它可能整桶清掉，表现就是某天开始每章又都要等 —— 清掉的东西都能重新算出来，不是坏了。'
            : disk.persisted === true
              ? ' 持久存储已拿到，浏览器不会主动清它。'
              : ' 这台浏览器不报持久存储的状态。');
  const usedValue = disk === undefined ? '正在问…' : disk === null ? '这台浏览器存不下来' : `${disk.entries} 张`;

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
          hint="页面图比屏幕窄时（手机和高倍屏上最常见），改由本机按显示尺寸重新采样并补一档高频，线条和小字更利落。增强版没算好之前这一页先空着（第一次打开一章约半秒），不会先给你看模糊的原图再换；算过的页回来还是那张增强图，不再换一次。费一点电；源图本来就够宽时不会动它。"
          control={<div className={`switch${on ? ' on' : ''}`} />}
          onClick={() => {
            /* 开这一档才会往本机盘上堆几百张图，所以就在用户这只手下再要一次持久存储 */
            if (!on) void requestPersist();
            prefs.patch({ enhanceScreen: !on });
          }}
        />
        <Row label="本机存下的增强图" value={usedValue} hint={usedHint} />
      </Section>
    </>
  );
}
