import { NavLink } from 'react-router-dom';
import { IconExplore, IconSearch, IconSettings, IconShelf } from '@/components/Icons';

/**
 * 底栏导航。
 *
 * 之前这段 JSX 在书架 / 发现 / 搜索三个页面各抄了一遍，设置页则整个漏掉，
 * 结果进了设置就没有返回入口。改用 NavLink 后连 active 都不用手写 ——
 * 路由匹配上时它自己加 `active` 类，正好对上 `.bottom-nav a.active`。
 */
const TABS = [
  { to: '/shelf', label: '书架', Icon: IconShelf },
  { to: '/explore', label: '发现', Icon: IconExplore },
  { to: '/search', label: '搜索', Icon: IconSearch },
  { to: '/settings', label: '设置', Icon: IconSettings },
] as const;

export default function BottomNav() {
  return (
    <nav className="bottom-nav">
      {TABS.map(({ to, label, Icon }) => (
        <NavLink key={to} to={to}>
          <Icon />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
