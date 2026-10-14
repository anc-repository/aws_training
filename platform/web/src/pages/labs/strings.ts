/**
 * 目录、路径、简介页、开始对话框、小测与“我的学习”的界面文案（08 §1.6；P02、P02-T、P03、P03-D、P03-Q、P10）。
 * 文案本身在词典 `src/i18n/<lang>/labs.ts`（09 §1）；这里是当前语言的别名与不随语言变化的常量（等级、形状、符号、顺序）。
 */
import { msg } from '../../i18n/core';
import type { Difficulty, MasteryLevel, ProvisionClass, SaaDomain } from './types';

const L = msg.labs;

export const DIFFICULTY_TEXT: Readonly<Record<Difficulty, string>> = L.difficulty;
export const DIFFICULTY_LEVEL: Readonly<Record<Difficulty, number>> = { intro: 1, beginner: 2, intermediate: 3, advanced: 4 };

export const DOMAIN_TEXT: Readonly<Record<SaaDomain, string>> = L.domain;

export const DURATION_TEXT: Readonly<Record<'short' | 'medium' | 'long', string>> = L.duration;

/** 部署等级（05 §3.4）：不写分钟数。 */
export const PROVISION_TEXT: Readonly<Record<ProvisionClass, string>> = L.provision;

export const PROVISION_HINT: Readonly<Record<ProvisionClass, string>> = L.provisionHint;

export const COST_TIER_HINT: Readonly<Record<'low' | 'medium' | 'high', string>> = L.costTierHint;

/** 提示标记（05 §2.8，按优先级）。 */
export const FLAG_TEXT: Readonly<Record<string, string>> = L.flag;
export const FLAG_ORDER = ['needs-advance', 'limited', 'needs-domain', 'domain-optional', 'needs-email', 'account-impact', 'long-wait', 'beta', 'new-version'] as const;

type MasteryShape = 'ring' | 'q1' | 'half' | 'dot';
const MASTERY_SHAPE: Readonly<Record<MasteryLevel, MasteryShape>> = { not_started: 'ring', touched: 'q1', mastered: 'half', proficient: 'dot' };

/** 掌握度等级（tracks-and-catalog §5.4；形状 + 文字；文字随语言变化）。 */
export const MASTERY_META: Readonly<Record<MasteryLevel, { readonly text: string; readonly shape: MasteryShape }>> = Object.fromEntries(
  (Object.keys(MASTERY_SHAPE) as MasteryLevel[]).map((k) => [
    k,
    {
      get text() {
        return L.mastery[k];
      },
      shape: MASTERY_SHAPE[k],
    },
  ]),
) as Record<MasteryLevel, { readonly text: string; readonly shape: MasteryShape }>;

/** 徽章等级（tracks-and-catalog §5.2；05 §2.10 的外环线型）。 */
export const BADGE_LEVEL_TEXT: Readonly<Record<string, string>> = L.badgeLevel;

type TrackRole = 'required' | 'optional' | 'group';
const ROLE_SYMBOL: Readonly<Record<TrackRole, string>> = { required: '●', optional: '○', group: '◇' };

export const ROLE_IN_TRACK: Readonly<Record<TrackRole, { readonly symbol: string; readonly text: string }>> = Object.fromEntries(
  (Object.keys(ROLE_SYMBOL) as TrackRole[]).map((k) => [
    k,
    {
      symbol: ROLE_SYMBOL[k],
      get text() {
        return L.roleInTrack[k];
      },
    },
  ]),
) as Record<TrackRole, { readonly symbol: string; readonly text: string }>;

/** 学员输入（05 §7.1 的输入 id）。 */
export const INPUT_TEXT: Readonly<Record<string, { label: string; need: string; hint?: string }>> = L.input;

export const STEP_TYPE_TEXT: Readonly<Record<string, string>> = L.stepType;

export const S = L.ui;

export const SECTION_TEXT = L.section;
