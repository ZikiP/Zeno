import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import LegalSheet from './LegalSheet';
import { listPlugins } from '@/store/plugins';
import { getEndpoint } from '@/sync/device';
import { sync } from '@/sync/client';

/**
 * 关于
 *
 * 出问题时最先要看的几个事实：哪个版本、这台连的是哪儿、装了几个源。
 * 抄给别人提问时不用来回截图。
 */
export default function AboutPanel() {
  const [sources, setSources] = useState<number | null>(null);
  const [legalOpen, setLegalOpen] = useState(false);

  useEffect(() => {
    void listPlugins().then((p) => setSources(p.length));
  }, []);

  const endpoint = getEndpoint();

  return (
    <>
      <p className="settings-note">
        一个自托管的漫画阅读器框架。书架、进度、书签都在你自己的设备上；
        内容源由使用者以插件形式配置，应用本身不附带任何来源。
      </p>

      <div className="settings-rows">
        <div className="settings-row">
          <span className="settings-row__name">版本</span>
          <span className="settings-row__value">{__APP_VERSION__}</span>
        </div>
        <div className="settings-row">
          <span className="settings-row__name">已装内容源</span>
          <span className="settings-row__value">
            {sources === null ? '读取中…' : `${sources} 个`}
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-row__name">同步服务端</span>
          <span className="settings-row__value">
            {endpoint || '未配置（只用本机）'}
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-row__name">这台设备</span>
          <span className="settings-row__value">{sync.getState().deviceLabel}</span>
        </div>
      </div>

      <h3 className="settings-h">条款</h3>
      <div className="settings-rows">
        <button className="settings-row" onClick={() => setLegalOpen(true)}>
          <span className="settings-row__name">使用须知与免责声明</span>
          <span className="settings-row__value">›</span>
        </button>
        <Link className="settings-row" to="/settings?tab=sources">
          <span className="settings-row__name">内容源怎么配</span>
          <span className="settings-row__value">去「内容源」栏 ›</span>
        </Link>
      </div>

      {legalOpen && <LegalSheet onClose={() => setLegalOpen(false)} />}
    </>
  );
}
