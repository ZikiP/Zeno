/**
 * 本地数据变更信号
 *
 * 问题背景：同步把远端数据写进 IndexedDB 后，页面上的书架、主题、
 * 插件列表都不知道该刷新 —— 数据变了但 UI 停在旧状态。
 *
 * 做法：变更时广播，各数据层通过 useDataVersion 订阅，
 * 依赖 version 变化就重新读。相当于一个极简的响应式数据层。
 *
 * 不用 React Context 传函数：那样每个页面都要包一层 Provider，
 * 而这里只是「戳一下让页面重读」，不涉及跨组件传值。
 */

const CHANNEL = 'zeno-data-change';

/**
 * 订阅数据变更。返回取消订阅函数。
 *
 * 两条通道都要挂：
 *   - BroadcastChannel 负责跨标签页
 *   - window 事件负责同标签页
 *
 * BroadcastChannel **不向发送方自己投递**，所以 emit 时必须额外派发 window 事件，
 * 否则「同步在本页完成后」这个最常见的情况收不到通知（实测踩过：
 * 同步条显示成功、书架也更新了，但主题还是旧的）。
 */
export function onDataChange(fn: () => void): () => void {
  window.addEventListener(CHANNEL, fn);

  let close: (() => void) | undefined;
  if (typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = () => fn();
    close = () => ch.close();
  }

  return () => {
    window.removeEventListener(CHANNEL, fn);
    close?.();
  };
}

/** 广播数据变更 */
export function emitDataChange() {
  // 先派发 window 事件（覆盖同标签页），再走 BroadcastChannel（覆盖其他标签页）
  window.dispatchEvent(new CustomEvent(CHANNEL));
  if (typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage('changed');
    ch.close();
  }
}
