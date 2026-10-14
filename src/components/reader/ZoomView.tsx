import { RetryableImage } from '@/components/RetryableImage';

/** 图片放大层：全屏、点任意处关闭 */
export default function ZoomView({
  src,
  index,
  background,
  onClose,
}: {
  src: string;
  index: number;
  background: string;
  onClose: () => void;
}) {
  return (
    <div className="zoom-view" style={{ background }}>
      <RetryableImage src={src} alt={`第 ${index + 1} 页`} onClick={onClose} />
      <div className="zoom-view__hint">点击任意处关闭</div>
    </div>
  );
}
