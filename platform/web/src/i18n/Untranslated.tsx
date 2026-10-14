/**
 * “未翻訳 / Not translated / 未翻译”标记（09 §1.6，决定 I2）：内容按回退链显示了其他语言时，在该内容旁边加一个不显眼的标记。
 * `lang` 是实际显示的语言（读屏按该语言朗读被标记的内容由调用方在内容元素上设置 lang 属性）。
 */
import './i18n.css';
import { msg } from './runtime';

export function Untranslated({ className }: { className?: string }) {
  return (
    <span className={`untranslated${className ? ` ${className}` : ''}`} title={msg.i18n.untranslatedHint}>
      {msg.i18n.untranslated}
    </span>
  );
}

/** `show` 为真时渲染标记，否则不渲染。 */
export function UntranslatedIf({ show, className }: { show: boolean | undefined; className?: string }) {
  return show ? <Untranslated className={className} /> : null;
}
