import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { formatAgo } from '@/store/utils';
import { sync, type SyncState } from '@/sync/client';

/**
 * 同步状态泡：挂在当前这一页顶栏的右端。
 *
 * 以前它是顶栏下面一整条 29px 高的状态条 —— 占掉一行布局、手机上很难点中，
 * 还跟顶栏抢视线。现在只剩一颗玻璃泡：一个颜色就说完了「同步好了」，
 * 文字只在鼠标停住或键盘聚焦时展开。
 *
 * 没配服务端地址时整颗不出现，跟以前一样不打扰纯本地用户。
 */

/**
 * 当前这一页的顶栏：`.app` 的直接孩子（`<Routes>` 自己不产生 DOM 元素，
 * 页面片段直接摊在 Shell 那个 div 下面）。正文里也有带 .topbar__spacer 的东西，
 * 所以必须限定成直接孩子，不能全文 querySelector。
 */
function findTopbar(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.app > .topbar');
}

/**
 * 把状态泡挂到当前顶栏上。
 *
 * 为什么是挂 DOM 而不是每页的 JSX 里各写一遍：五个页面路由都有顶栏，
 * 写五遍就是五处要记得改的地方；挂进来只有一份，路由一换自己跟着走。
 *
 * 找的位置只有 `.app > .topbar` 那一层：`<Routes>` 自己不产生 DOM 元素，
 * 所以页面片段（顶栏 + 正文）直接就是 Shell 那个 div 的孩子。
 *
 * 为什么是轮询而不是 MutationObserver：观察器一旦在挂上之后被拆掉（第一版就是在
 * 这个时机拆的），换页就再也没有事件提醒我们重挂 —— 顶栏换了但 `.app` 没动，
 * 上层根本观察不到。全程开着 subtree 观察又会被图片、列表这些无关变动反复触发。
 * 所以挂上之后也继续自查，只是把频率压到 400ms：一次 querySelector + 一次
 * isConnected，换页后最多迟到 400ms 才补上那颗泡，平时代价可以忽略。
 */
const SEEK_MS = 400;

function useTopbarSlot() {
  const hostRef = useRef<HTMLElement | null>(null);
  /* portal 的父节点换了必须让组件重渲染一次，否则它还往已经断连的旧节点里渲染 */
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let timer = 0;

    const tick = () => {
      if (!hostRef.current?.isConnected) {
        hostRef.current?.remove();
        const topbar = findTopbar();
        if (topbar) {
          const el = document.createElement('div');
          el.className = 'topbar__sync';
          topbar.appendChild(el);
          hostRef.current = el;
          setHost(el);
        } else {
          hostRef.current = null;
        }
      }
      timer = window.setTimeout(tick, SEEK_MS);
    };

    tick();
    return () => {
      window.clearTimeout(timer);
      hostRef.current?.remove();
      hostRef.current = null;
    };
  }, []);

  return host;
}

function readout(s: SyncState): { tone: 'ok' | 'busy' | 'error'; label: string; tip: string } {
  if (s.syncing) return { tone: 'busy', label: '同步中', tip: '正在跟服务端对数据' };
  if (!s.online) {
    return {
      tone: 'error',
      label: '离线',
      tip: s.error ? `连不上同步服务：${s.error}` : '连不上同步服务',
    };
  }
  return {
    tone: 'ok',
    label: s.lastSyncAt ? `已同步 · ${formatAgo(s.lastSyncAt)}` : '已同步',
    tip: '同步正常',
  };
}

export default function SyncPill() {
  const [state, setState] = useState<SyncState>(sync.getState());
  const slot = useTopbarSlot();
  const nav = useNavigate();

  useEffect(() => sync.subscribe(setState), []);

  if (!slot || !state.endpoint) return null;

  const { tone, label, tip } = readout(state);
  return createPortal(
    <button
      type="button"
      className={`sync-pill sync-pill--${tone}`}
      title={tip}
      aria-label={`${tip}，查看同步设置`}
      onClick={() => nav('/settings?tab=sync')}
    >
      <span className="sync-pill__dot" />
      <span className="sync-pill__label">{label}</span>
    </button>,
    slot,
  );
}
