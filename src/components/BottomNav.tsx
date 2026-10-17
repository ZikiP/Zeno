import { NavLink } from 'react-router-dom';
import UseAnimations, { type Animation, type Interaction } from 'react-useanimations';
import book from 'react-useanimations/lib/book';
import explore from 'react-useanimations/lib/explore';
import settings2 from 'react-useanimations/lib/settings2';
import { searchToggle } from '@/components/icons/uaSearch';

type Tab = {
  to: string;
  label: string;
  animation: Animation;
  /**
   * 双状态图标（click-toggle）才能跟着路由停在终态；
   * 只有一段动画的图标只能「点一下演一遍」。
   */
  interaction: Interaction;
};

/**
 * 底栏导航。
 *
 * 图标换成 UseAnimations 的动画图标。只有双状态的图标（click-toggle）能跟着路由
 * 停在终态；只有一段动画的那些（book、explore 默认是 hover 系）强制成 click-replay，
 * 点一下演一遍 —— 它们的 hover 演法在触屏上是直接忽略触摸的。
 *
 * 搜索那颗是照 UseAnimations 的格式自己做的放大镜（它没有可用的放大镜资产，
 * 只有 searchToX —— 点一下变成叉，当 tab 的选中态语义正好反了），所以它也是双状态。
 */
const TABS: Tab[] = [
  { to: '/shelf', label: '书架', animation: book, interaction: 'click-replay' },
  { to: '/explore', label: '发现', animation: explore, interaction: 'click-replay' },
  { to: '/search', label: '搜索', animation: searchToggle, interaction: 'click-toggle' },
  { to: '/settings', label: '设置', animation: settings2, interaction: 'click-toggle' },
];

export default function BottomNav() {
  return (
    <nav className="bottom-nav">
      {TABS.map(({ to, label, animation, interaction }) => (
        <NavLink key={to} to={to}>
          {({ isActive }) => (
            <>
              <UseAnimations
                animation={animation}
                size={22}
                interaction={interaction}
                active={interaction === 'click-toggle' ? isActive : undefined}
                /* 播放器给 wrapper 写了 overflow:hidden，而选中态要把 svg 放大 1.08
                   —— 不放开就会被裁掉一圈，旋转过的图标（搜索）更明显 */
                wrapperStyle={{ overflow: 'visible' }}
              />
              {label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
