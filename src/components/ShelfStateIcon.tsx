import { useEffect, useRef, useState } from 'react';
import { IconShelf } from '@/components/Icons';

type Phase = 'idle' | 'in' | 'out';

/**
 * 书架状态图标。
 *
 * 三个书脊的形状一直在，在架时右下角弹出一个带勾的角标 —— 不是把书架换成勾，
 * 那样图标和它的语义就成两回事了。
 *
 * 只在状态真的翻了才演：进页面时本来就在书架上，直接摆终态，不放一遍入场动画。
 */
export default function ShelfStateIcon({ on, size = 16 }: { on: boolean; size?: number }) {
  const prev = useRef(on);
  const [phase, setPhase] = useState<Phase>('idle');

  useEffect(() => {
    if (prev.current === on) return;
    prev.current = on;
    setPhase(on ? 'in' : 'out');
  }, [on]);

  /* 摘角标要等收出去演完才卸载 */
  const mounted = on || phase === 'out';

  return (
    <span className="state-icon" style={{ width: size, height: size }} aria-hidden="true">
      <IconShelf size={size} />
      {mounted && (
        <svg
          className={phase === 'in' ? 'state-icon__badge is-in' : phase === 'out' ? 'state-icon__badge is-out' : 'state-icon__badge'}
          viewBox="0 0 12 12"
          width={Math.round(size * 0.6)}
          height={Math.round(size * 0.6)}
          onAnimationEnd={(e) => {
            if (e.animationName === 'badge-out') setPhase('idle');
          }}
        >
          <circle className="state-icon__disc" cx="6" cy="6" r="5.4" />
          <path className="state-icon__tick" pathLength={1} d="M3.4 6.2l1.9 1.9 3.5-4.1" />
        </svg>
      )}
    </span>
  );
}
