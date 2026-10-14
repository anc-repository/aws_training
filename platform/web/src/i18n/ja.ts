/**
 * ja（日本語） 词典（由 `npm run i18n:sync` 生成；译文写在 `ja/<ns>.ts`）。
 */
import type { Dict } from './dict';
import type { Messages } from './zh-CN';
import core from './ja/core';
import card from './ja/card';
import certificates from './ja/certificates';
import end from './ja/end';
import experiments from './ja/experiments';
import frame from './ja/frame';
import labs from './ja/labs';
import learning from './ja/learning';
import pages from './ja/pages';
import report from './ja/report';
import sessions from './ja/sessions';
import settings from './ja/settings';
import setup from './ja/setup';
import share from './ja/share';
import ui from './ja/ui';
import verify from './ja/verify';
import workspace from './ja/workspace';

export const ja: Dict<Messages> = {
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
