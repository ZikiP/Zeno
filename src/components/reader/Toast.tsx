/** 轻提示。定时移除由页面负责（useFlashToast） */
export default function Toast({ text }: { text: string }) {
  return <div className="reader__toast">{text}</div>;
}
