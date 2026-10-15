import Tabs, { TabPanel } from '@/components/Tabs';
import BottomNav from '@/components/BottomNav';
import AppearancePanel from './AppearancePanel';
import SourcesPanel from './SourcesPanel';
import CachePanel from './CachePanel';
import SyncPanel from './SyncPanel';
import AboutPanel from './AboutPanel';
import { useTheme } from '@/hooks/useTheme';

/**
 * 设置
 *
 * 分五栏，一栏管一件事。「同步」和「缓存」原来各是一个弹层：从状态条点进去
 * 改完关掉，再想改缓存又得回这页找入口，两件事在界面上根本没有归属。
 *
 * 当前哪一栏写在地址里（?tab=）：这样状态条可以直接链到「同步」，
 * 分享一个链接就能把人送到要改的那一栏，返回键也照常 work。
 */

const TABS = [
  { key: 'appearance', label: '外观' },
  { key: 'sources', label: '内容源' },
  { key: 'cache', label: '缓存' },
  { key: 'sync', label: '同步' },
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
  const { resolved } = useTheme();

  return (
    <>
      <header className="topbar">
        <div className="topbar__title">设置</div>
        <div className="topbar__spacer" />
        {/* 只是提示当前深浅色，切换在「外观」栏里 —— 这里再放一颗按钮会让人以为别处不能改 */}
        <span className="topbar__hint">{resolved === 'light' ? '浅色' : '深色'}</span>
      </header>

      <Tabs items={TABS} value={value} onChange={onTabChange} label="设置分区" />

      <main className="main">
        <TabPanel id={value}>
          {value === 'appearance' && <AppearancePanel />}
          {value === 'sources' && <SourcesPanel />}
          {value === 'cache' && <CachePanel />}
          {value === 'sync' && <SyncPanel />}
          {value === 'about' && <AboutPanel />}
        </TabPanel>
      </main>

      <BottomNav />
    </>
  );
}
