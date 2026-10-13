/**
 * 表单字段（08 §8.6）：每个输入有可见标签；错误信息在字段下方，aria-invalid + aria-describedby；说明文字同样经 aria-describedby 关联。
 * 服务端 `400 VALIDATION_FAILED` 的字段错误回填到同一位置（error）。
 */
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

export interface FieldProps {
  label: ReactNode;
  /** 单个输入元素（input / select / textarea），Field 负责 id 与 aria 属性。 */
  children: ReactElement<Record<string, unknown>>;
  hint?: ReactNode;
  error?: string | null;
}

export function Field({ label, children, hint, error }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
      })
    : children;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {control}
      {hint ? (
        <span id={hintId} className="small muted">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errId} className="ferr">
          {error}
        </span>
      ) : null}
    </div>
  );
}
