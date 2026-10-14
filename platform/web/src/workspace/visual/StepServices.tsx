/**
 * 步骤顶部的服务图标行（09 I6 e、V9“步骤顶部的相关服务用 <ServiceGlyph size={16..20}> 一行”）：图标 + 产品短名（不翻译，I3），
 * 悬停显示“服务名 · 组名”。列表本身带可访问名称“本步相关服务”，每项的读屏文字是“服务名（机能）”。
 */
import { useMemo } from 'react';
import { glyphModule, ServiceGlyph } from '../../ui/glyphs';
import type { LabDoc, LabStep } from '../model/lab';
import { stepModules } from '../model/stepServices';

import { W } from '../strings';

export function StepServices({ lab, step }: { lab: LabDoc; step: LabStep }) {
  const ids = useMemo(() => stepModules(lab, step), [lab, step]);
  if (!ids.length) return null;
  return (
    <ul className="step-svcs" aria-label={W.step.services} data-step-services={ids.join(' ')}>
      {ids.map((id) => (
        <li key={id} data-module={id}>
          <ServiceGlyph id={id} size={20} label tooltip />
          <span className="small" aria-hidden="true">
            {glyphModule(id)?.short ?? id}
          </span>
        </li>
      ))}
    </ul>
  );
}
