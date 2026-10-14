import { describe, expect, it } from 'vitest';
import { fallbackLang } from './content';
import { joinSoftBreaks } from './text';

describe('joinSoftBreaks', () => {
  it('drops a soft line break between CJK characters or full-width punctuation, keeps it elsewhere', () => {
    expect(joinSoftBreaks('書き込まれます。\n同じディスクには')).toBe('書き込まれます。同じディスクには');
    expect(joinSoftBreaks('使い切られ、\n  ディスクが')).toBe('使い切られ、ディスクが');
    expect(joinSoftBreaks('写入数据卷，\n同一块盘')).toBe('写入数据卷，同一块盘');
    expect(joinSoftBreaks('written to disk.\nThe same')).toBe('written to disk.\nThe same');
    expect(joinSoftBreaks('S3 に\nPUT します')).toBe('S3 に\nPUT します');
    expect(joinSoftBreaks('no break')).toBe('no break');
  });
});

describe('fallbackLang', () => {
  it('tells the language a fallback text is in (chain selected → en → zh-CN)', () => {
    expect(fallbackLang('尝试未完成')).toBe('zh-CN');
    expect(fallbackLang('未完了です')).toBe('en'); // kana: not a zh-CN fallback
    expect(fallbackLang('Amazon S3')).toBe('en');
  });
});
