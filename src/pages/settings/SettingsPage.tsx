import Tabs, { TabPanel } from '@/components/Tabs';
import AppearancePanel from './AppearancePanel';
import ReadingPanel from './ReadingPanel';
import SourcesPanel from './SourcesPanel';
import CachePanel from './CachePanel';
import SyncPanel from './SyncPanel';
import ExperimentPanel from './ExperimentPanel';
import AboutPanel from './AboutPanel';

/**
 * 设置
 *
 * 分七栏，一栏管一件事。「同步」和「缓存」原来各是一个弹层：从状态条点进去
 * 改完关掉，再想改缓存又得回这页找入口，两件事在界面上根本没有归属。
 *
 * 「实验」排在稳定项之后、关于之前：里面全是可能整条删掉的东西，
 * 不该和阅读偏好那种"会一直留在这儿"的项混在一栏。
 *
 * 当前哪一栏写在地址里（?tab=）：这样状态条可以直接链到「同步」，
 * 分享一个链接就能把人送到要改的那一栏，返回键也照常 work。
 */

const TABS = [
  { key: 'appearance', label: '外观' },
  { key: 'read', label: '阅读' },
  { key: 'sources', label: '内容源' },
  { key: 'cache', label: '缓存' },
  { key: 'sync', label: '同步' },
  { key: 'experiment', label: '实验' },
  { key: 'about', label: '关于' },
] as const;

const DEFAULT_TAB = 'appearance';

/** 地址里那一段是不是一个认识的栏名。认不出就回默认栏，不报错 */
function tabFromParam(raw: string | null): string {
  return TABS.some((t) => t.key === raw) ? (raw as string) : DEFAULT_TAB;
}

export default function SettingsPage({
  tab,
  onTabChange,
}: {
  tab: string | null;
  onTabChange: (key: string) => void;
}) {
  const value = tabFromParam(tab);

  return (
    <>
      <header className="topbar">
        <div className="topbar__title">设置</div>
        <div className="topbar__spacer" />
      </header>

      <Tabs items={TABS} value={value} onChange={onTabChange} label="设置分区" />

      <main className="main">
        <TabPanel id={value}>
          {value === 'appearance' && <AppearancePanel />}
          {value === 'read' && <ReadingPanel />}
          {value === 'sources' && <SourcesPanel />}
          {value === 'cache' && <CachePanel />}
          {value === 'sync' && <SyncPanel />}
          {value === 'experiment' && <ExperimentPanel />}
          {value === 'about' && <AboutPanel />}
        </TabPanel>
      </main>

    </>
  );
}
