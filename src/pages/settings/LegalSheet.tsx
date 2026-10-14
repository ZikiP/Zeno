import { Sheet } from '@/components/UI';

/** 使用须知与免责声明 */
export default function LegalSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="使用须知" onClose={onClose}>
      <div style={{ fontSize: 13, lineHeight: 1.85, color: 'var(--text-dim)' }}>
        <p style={{ marginTop: 0 }}>
          <strong style={{ color: 'var(--text)' }}>Zeno 是一个技术工具</strong>
          ，只提供「把网页内容呈现得更干净」的通用能力。它不内置、不推荐、不分发任何内容源。
        </p>

        <p>
          <strong style={{ color: 'var(--text)' }}>版权</strong>
          ：通过本工具访问、下载或缓存的任何内容，其著作权归各自权利人所有。
          相关责任由使用者自行承担。请遵守目标站点的服务条款，并遵守你所在地区的法律法规。
          仅供个人学习与非商业用途。
        </p>

        <p>
          <strong style={{ color: 'var(--text)' }}>插件由第三方提供</strong>
          ：插件是他人编写的解析规则，不经本项目审核与背书。
          导入插件即表示你自行判断并接受其内容与用途。插件作者不因使用本项目而获得任何授权或认可。
        </p>

        <p>
          <strong style={{ color: 'var(--text)' }}>不提供内容</strong>
          ：本项目仓库中不包含任何漫画内容、图片或默认插件。
        </p>

        <p>
          <strong style={{ color: 'var(--text)' }}>无担保</strong>
          ：代码按 MIT 协议提供，不作任何明示或暗示担保。
          目标站点随时可能改版，届时插件的解析规则可能失效。
        </p>
      </div>
    </Sheet>
  );
}
