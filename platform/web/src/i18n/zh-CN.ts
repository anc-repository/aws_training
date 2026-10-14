/**
 * zh-CN 词典（源语言，09 §1.2）：各命名空间在 `zh-CN/<ns>.ts`，这里合并成一个对象（由 `npm run i18n:sync` 生成）。
 * ja / en 词典的键必须与这里完全一致（`npm run i18n:check`）；新增命名空间或键后运行 `npm run i18n:sync`。
 * 组件不直接引用本对象，而是引用当前语言的 `msg`（runtime.ts）。
 */
import core from './zh-CN/core';
import card from './zh-CN/card';
import certificates from './zh-CN/certificates';
import end from './zh-CN/end';
import experiments from './zh-CN/experiments';
import frame from './zh-CN/frame';
import labs from './zh-CN/labs';
import learning from './zh-CN/learning';
import pages from './zh-CN/pages';
import report from './zh-CN/report';
import sessions from './zh-CN/sessions';
import settings from './zh-CN/settings';
import setup from './zh-CN/setup';
import share from './zh-CN/share';
import ui from './zh-CN/ui';
import verify from './zh-CN/verify';
import workspace from './zh-CN/workspace';

export const zhCN = {
  ...core,
  card,
  certificates,
  end,
  experiments,
  frame,
  labs,
  learning,
  pages,
  report,
  sessions,
  settings,
  setup,
  share,
  ui,
  verify,
  workspace,
};

export type Messages = typeof zhCN;
