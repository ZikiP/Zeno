import { useEffect, useRef } from 'react';
import { failedCountAmong, onImageHealthChange } from '@/components/RetryableImage';

/**
 * 整源坏了要说一句
 *
 * 每张图自己都有"加载失败 · 点此重试"，但五十个这样的格子摆在那儿，
 * 谁也读不出"这一章的图床整个不通" —— 而那是完全不同的两件事：
 * 一张是 CDN 抽风，重试就好；整源坏了，重试到明天也没用，该换一本/换一个源。
 *
 * 实测到的真实形态：包子漫画《一人之下》的章节图会 302 到另一台节点，
 * 而那台从这台机器连 TLS 握手都完不成，于是整章每张图 502。
 */

/** 几张起说。一两张是抖动，专门弹一句反而是噪音 */
const THRESHOLD = 3;

export function useImageHealthFlash(images: string[] | null, flash: (text: string) => void) {
  /** 同一章只说一次。说第二遍不会改变任何事，却会把提示条一直占住 */
  const told = useRef(false);

  useEffect(() => {
    told.current = false;
  }, [images]);

  useEffect(() => {
    if (!images?.length) return;
    const check = () => {
      if (told.current) return;
      const n = failedCountAmong(images);
      if (n < THRESHOLD) return;
      told.current = true;
      // 说"至少几张"而不是"几张"：这是过阐值那一刻的数，之后还在往上涨，
      // 报个死数字会让人以为剩下的那些是另一种毛病
      flash(`这一章至少 ${n} 张图取不到 —— 多半是源站的图床坏了，不像是你这边的问题`);
    };
    check();
    return onImageHealthChange(check);
  }, [images, flash]);
}
