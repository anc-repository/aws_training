/** 卡片容器与区块（原型 `.box`、`.sec`）。区块标题是 h2，`aside` 放在标题行右侧。 */
import type { HTMLAttributes, ReactNode } from 'react';

export interface BoxProps extends HTMLAttributes<HTMLDivElement> {
  inset?: boolean;
}

export function Box({ inset, className, ...rest }: BoxProps) {
  return <div className={['box', inset ? 'inset' : '', className].filter(Boolean).join(' ')} {...rest} />;
}

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  aside?: ReactNode;
  headingId?: string;
}

export function Section({ title, aside, headingId, className, children, ...rest }: SectionProps) {
  return (
    <section className={['sec', className].filter(Boolean).join(' ')} aria-labelledby={headingId} {...rest}>
      <h2 id={headingId}>
        {title}
        {aside ? <span className="aside">{aside}</span> : null}
      </h2>
      {children}
    </section>
  );
}
