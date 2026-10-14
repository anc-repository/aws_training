/**
 * “未翻訳 / Not translated / 未翻译”标记（09 §1.6，决定 I2）：内容按回退链显示了其他语言时，在该内容旁边加一个不显眼的标记。
 *
 * 回退显示的文字本身要带实际语言的 `lang` 属性（WCAG 3.1.2 Language of Parts：读屏按该语言朗读，字体栈也随之切换，
 * tokens.css 的 `[lang]` 规则）：内容字段用 `<InLang lang={actualLang(…)}>` 或 `<FallbackText>`；服务器记录的中文值
 * （API 的 detail、报告里的原因、签发时写入的证书标题）用 `<Recorded>`。
 */
import type { ReactNode } from 'react';
import './i18n.css';
import { fallbackLang } from './content';
import { useLocale } from './hooks';
import type { Locale } from './locale';
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

/** 一段与界面语言不同的文字：`lang` 与界面语言相同（或为 null）时不加元素。 */
export function InLang({ lang, children }: { lang: Locale | null | undefined; children: ReactNode }) {
  const locale = useLocale();
  return lang && lang !== locale ? <span lang={lang}>{children}</span> : <>{children}</>;
}

/** 内容字段：`show`（该字段走了回退）时文字带实际语言的 lang，后面跟“未翻訳”标记。 */
export function FallbackText({ text, show, marker = true }: { text: string; show: boolean | undefined; marker?: boolean }) {
  if (!show) return <>{text}</>;
  return (
    <>
      <InLang lang={fallbackLang(text)}>{text}</InLang>
      {marker ? (
        <>
          {' '}
          <Untranslated />
        </>
      ) : null}
    </>
  );
}

/**
 * 服务器记录的文字（中文源文案：API 错误的 detail、报告的原因、签发时写入的证书标题）：界面不是中文、文字是中文时
 * 带 lang="zh-CN"；`marker` 为真时再加“未翻訳”标记。不含汉字（或含假名）的文字原样显示。
 */
export function Recorded({ text, marker = false }: { text: string | null | undefined; marker?: boolean }) {
  const locale = useLocale();
  const s = text ?? '';
  if (locale === 'zh-CN' || fallbackLang(s) !== 'zh-CN') return <>{s}</>;
  return (
    <>
      <span lang="zh-CN">{s}</span>
      {marker ? (
        <>
          {' '}
          <Untranslated />
        </>
      ) : null}
    </>
  );
}
