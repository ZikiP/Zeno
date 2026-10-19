import { Link } from 'react-router-dom';
import { Sheet } from '@/components/UI';

/**
 * 详情页右上角那颗齿轮开的弹层。
 *
 * 单独成组件有两个原因：ComicPage 本来就越了 250 行的组件上限；
 * 而这一层跟"这本漫画的数据"无关，它只是两个跳转入口。
 *
 * 追漫不放这儿：它跟「离线下载」是同一类动作（把内容提前弄到机器上），
 * 那颗按钮就在动作行里，同一个状态摆两处只会让人怀疑它们是不是一回事。
 */
export default function ComicSheet({
  sourceName,
  onClose,
  onRemove,
}: {
  sourceName: string;
  onClose: () => void;
  /** 移除并清缓存。返回 true 表示真删掉了，页面据此决定要不要回书架 */
  onRemove: () => Promise<boolean>;
}) {
  return (
    <Sheet title="阅读设置" onClose={onClose}>
      <div className="opt-row">
        <div>
          <div className="opt-row__label">内容源</div>
          <div className="opt-row__hint">{sourceName}</div>
        </div>
        {/* 一本书属于一个源，这里没有"切换"可言 —— 要换的是启用了哪些源 */}
        <Link to="/settings?tab=sources" className="btn btn--ghost btn--sm">
          管理
        </Link>
      </div>
      <div className="opt-row">
        <div>
          <div className="opt-row__label">从书架移除</div>
          <div className="opt-row__hint">同时清除该漫画的离线缓存</div>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={() => void onRemove()}>
          移除
        </button>
      </div>
    </Sheet>
  );
}
