import type { ReactNode } from 'react';

/** 分组标题 */
export function Divider({ text }: { text: string }) {
  return (
    <div style={{ margin: '6px 0 2px' }}>
      <div style={{ height: 1, background: 'var(--border)', marginBottom: 8 }} />
      <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{text}</div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 38,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--text)',
  fontSize: 13,
  outline: 'none',
};

/** 带说明文字的输入框 */
export function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** 令牌一类的敏感输入用 password，否则肩后有人就看见了 */
  type?: 'text' | 'password';
}) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 13, marginBottom: 4 }}>{label}</div>
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4, lineHeight: 1.5 }}>
          {hint}
        </div>
      )}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={inputStyle}
      />
    </label>
  );
}

/** 竖排字段容器 */
export function FieldGroup({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>;
}
