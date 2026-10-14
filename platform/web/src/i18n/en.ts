/**
 * en（English） 词典（由 `npm run i18n:sync` 生成；译文写在 `en/<ns>.ts`）。
 */
import type { Dict } from './dict';
import type { Messages } from './zh-CN';
import core from './en/core';
import card from './en/card';
import certificates from './en/certificates';
import end from './en/end';
import experiments from './en/experiments';
import frame from './en/frame';
import labs from './en/labs';
import learning from './en/learning';
import pages from './en/pages';
import report from './en/report';
import sessions from './en/sessions';
import settings from './en/settings';
import setup from './en/setup';
import share from './en/share';
import ui from './en/ui';
import verify from './en/verify';
import workspace from './en/workspace';

export const en: Dict<Messages> = {
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
