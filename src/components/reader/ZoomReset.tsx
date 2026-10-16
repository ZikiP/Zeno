import { IconContract } from '@/components/Icons';

/**
 * 还原：图片被双指放大过才浮出来，点一下回到正常大小。
 *
 * 材质、显隐方式全部照章末胶囊那颗来（同一组玻璃、同样的 data-hidden 滑走），
 * 它是浮在阅读画面上的第三件东西，不该长得跟前两件不一样。
 */
export default function ZoomReset({
  visible,
  onReset,
}: {
  /** 放大态且菜单收起 —— 菜单一展开放大就归位了，这时它没有对象可还原 */
  visible: boolean;
  onReset: () => void;
}) {
  return (
    <button
      type="button"
      className="reader__zoom-reset"
      data-hidden={visible ? undefined : 'true'}
      onClick={onReset}
      aria-label="还原图片大小"
      title="还原"
    >
      <IconContract size={18} />
    </button>
  );
}
