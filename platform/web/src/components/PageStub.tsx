/**
 * 画面桩：脚手架阶段每个路由先渲染它，后续实现者按 08 §4 的画面规格替换。
 * 保留页面骨架约定：每个画面一个 h1（tabIndex=-1，路由切换后焦点移到这里，§8.2）、页头 `.ph`。
 */
import type { ReactNode } from 'react';
import { zhCN } from '../i18n/zh-CN';

export interface PageStubProps {
  /** 画面编号（P00～P13）。 */
  screen: string;
  title: string;
  /** 规格出处（只在桩中显示，正式画面不出现实现细节，§1.6）。 */
  spec: string;
  children?: ReactNode;
}

export function PageStub({ screen, title, spec, children }: PageStubProps) {
  return (
    <div className="stack-16" data-screen={screen}>
      <div className="ph">
        <h1 tabIndex={-1}>{title}</h1>
        <span className="sub">{zhCN.app.todo}</span>
      </div>
      <p className="small faint">
        {screen} · {spec}
      </p>
      {children}
    </div>
  );
}
