/**
 * 目录、简介页、学习页、设置与首次设置的多语言（09 §1；I1、I2、I5）与视觉化（I6 c、d、f）：
 * - 本组画面的 ja / en 词典（labs、card、setup、learning、settings、pages）没有缺键、空值与占位符不一致；
 * - 模块级的文案表在切换语言后取到新语言（词典叶子原地改写，表里不能存字符串副本）；
 * - 日语界面渲染目录与简介页：页面文案、<html lang>、Intl 的分钟与“未翻訳”标记。
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { compareDicts } from '../../i18n/dict';
import { en } from '../../i18n/en';
import { ja } from '../../i18n/ja';
import { setLocale } from '../../i18n';
import { zhCN } from '../../i18n/zh-CN';
import CardIntroPage from '../card/CardIntroPage';
import { amountText } from '../card/startModel';
import CatalogPage from './CatalogPage';
import { filterSummary } from './components/FacetBar';
import { inheritWholeI18n } from './data';
import { emptyQuery } from './model';
import { catalogIndex, renderPage } from './testing';

const NAMESPACES = ['labs', 'card', 'setup', 'learning', 'settings', 'pages'] as const;

afterEach(() => setLocale('zh-CN', { persist: false }));

describe('web-catalog i18n', () => {
  it.each(NAMESPACES)('ja / en dictionaries of %s are complete (no missing, empty or mismatched keys)', (ns) => {
    for (const dict of [ja, en]) {
      expect(compareDicts(zhCN[ns], dict[ns])).toEqual([]);
    }
  });

  it('module-level text tables follow the current language (getters, not copies)', () => {
    const q = { ...emptyQuery(), kind: ['service' as const] };
    const tax = catalogIndex().taxonomy;
    expect(filterSummary(q, tax)).toBe('类型：单服务');
    setLocale('en', { persist: false });
    expect(filterSummary(q, tax)).toBe('Type: Service');
    setLocale('ja', { persist: false });
    expect(filterSummary(q, tax)).toBe('種類：サービス');
    expect(amountText({ kind: 'range', low: 0.05, high: 0.07, unit: ' /時間' }, 'USD')).toBe('≈ $0.050～$0.070 /時間');
    setLocale('en', { persist: false });
    expect(amountText({ kind: 'range', low: 0.05, high: 0.07, unit: ' /hour' }, 'USD')).toBe('≈ $0.050–$0.070 /hour');
  });

  it('a catalog that fell back to the source language marks every card as untranslated', () => {
    const idx = { ...catalogIndex(), i18n: { lang: 'ja', whole: true } };
    const out = inheritWholeI18n(idx as never);
    expect((out.cards[0] as { i18n?: unknown }).i18n).toEqual({ lang: 'ja', whole: true });
    expect((out.tracks[0] as { i18n?: unknown }).i18n).toEqual({ lang: 'ja', whole: true });
    expect(inheritWholeI18n(catalogIndex())).toEqual(catalogIndex());
  });

  it('renders the catalog in Japanese: UI text, <html lang>, Intl minutes, icons and mini diagrams', async () => {
    setLocale('ja', { persist: false });
    renderPage({ path: '/labs', route: '/labs', element: <CatalogPage /> });
    expect(await screen.findByRole('heading', { level: 1, name: 'カード一覧' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('ja');
    const ec2 = await screen.findByRole('article', { name: /Amazon EC2/ });
    expect(ec2.textContent).not.toContain('サービス · 基礎');
    expect(ec2.closest('section')?.querySelector('h2')?.textContent).toContain('基礎');
    expect(ec2.querySelector('[data-metric="duration"]')!.textContent).toContain('60 分');
    expect(ec2.querySelector('[data-metric="difficulty"]')!.textContent).toContain('入門');
    expect(ec2.querySelector('[data-arch="svc-ec2"] svg')).toBeTruthy();
    await waitFor(() => expect(within(ec2).getByText('完了')).toBeTruthy());
    expect(screen.getByRole('heading', { level: 2, name: /シナリオカード/ })).toBeTruthy();
  });

  it('renders the card intro in English with the architecture pair, the comparison and the step icons', async () => {
    setLocale('en', { persist: false });
    renderPage({ path: '/labs/svc-queue', route: '/labs/:labId', element: <CardIntroPage />, others: ['/workspace/:sid'] });
    expect(await screen.findByRole('heading', { level: 2, name: 'At start → When done' })).toBeTruthy();
    expect(await screen.findByText('Without SQS')).toBeTruthy();
    expect(screen.getByText('With SQS')).toBeTruthy();
    const steps = screen.getByRole('heading', { level: 2, name: 'Steps at a glance' }).closest('section')!;
    expect(steps.querySelector('[data-step="enable-sqs"]')!.textContent).toContain('About 3 min wait');
    expect(steps.querySelector('[data-step="enable-sqs"] [data-step-type="script"]')).toBeTruthy();
    expect(screen.getAllByText('Details').length).toBeGreaterThan(0);
  });
});
