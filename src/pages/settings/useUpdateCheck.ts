import { useCallback, useRef, useState } from 'react';
import { checkUpdatesNow, getUpdates } from '@/store/updates';

/**
 * 手动踢一轮追更检查
 *
 * 为什么要手动入口：服务端那一轮默认 12 小时一次、开机后 60 秒才跑第一次。
 * 刚把一本书加进书架的人不想等下一个 12 小时 —— 而他按这一下的时候，
 * 界面上必须告诉他"还在跑"，因为一本一本串着取，五本要十几秒、几十本要几分钟。
 *
 * 服务端只回"已开始"（202），结果得回头看表。什么时候算跑完？
 * 客户端不知道书架总共几本（有的还没被写过行），所以用"安静下来"当判据：
 * 连续三拍没有新的 checkedAt 就算这一轮结束了 —— 跟渲染那边等页面的做法同构。
 */
const POLL_MS = 4000;
/** 连续这么多拍没再动静，就算这一轮跑完了 */
const QUIET_POLLS = 3;
/** 总上限：超过就只说"还在跑"，别在这儿吊着一个永远不结束的循环 */
const MAX_WAIT_MS = 5 * 60_000;

export function useUpdateCheck() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const running = useRef(false);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setResult('已让服务端开始检查…');
    const t0 = Date.now();
    try {
      await checkUpdatesNow();
      let lastMove = t0;
      let quiet = 0;
      while (Date.now() - t0 < MAX_WAIT_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        /* 轮询要每一拍的真实结果，不能被 getUpdates 的 5 秒缓存挡住 */
        const info = await getUpdates(true);
        const newest = Math.max(t0, ...info.items.map((r) => r.checkedAt));
        if (newest !== lastMove) {
          lastMove = newest;
          quiet = 0;
          const soFar = info.items.filter((r) => r.checkedAt > t0).length;
          setResult(`已看完 ${soFar} 本…`);
          continue;
        }
        if (++quiet >= QUIET_POLLS) {
          const done = info.items.filter((r) => r.checkedAt > t0);
          const changed = done.filter((r) => r.changedAt && r.changedAt > t0).length;
          const failed = done.filter((r) => r.error).length;
          setResult(
            done.length
              ? `看了 ${done.length} 本，${changed} 本有新章${failed ? `，${failed} 本没取到` : ''}`
              : '书架上暂时没有可查的书',
          );
          return;
        }
      }
      setResult('这一轮还没跑完（书多、站点慢），稍后回书架看');
    } catch (e) {
      // 服务端的追更没开、或者压根连不上 —— 说清楚，别只转圈
      setResult(`检查没启动：${(e as Error).message}`);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, result, run };
}
