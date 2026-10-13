import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem } from '../../test/helpers';
import { callsOf, renderPage } from '../labs/testing';
import QuizPage from './QuizPage';

const ATTEMPT = '01JQUIZ0000000000000000001';
const start = {
  attemptId: ATTEMPT,
  labId: 'svc-queue',
  deadlineAt: null,
  questions: [
    { id: 'q1', type: 'single', domain: 'resilient', stem: '可见性超时应该怎么设？', options: [{ id: 'a', text: '短轮询' }, { id: 'b', text: '大于最长处理时间' }] },
    { id: 'q2', type: 'multiple', domain: 'performance', stem: '处理毒消息（选两项）', options: [{ id: 'x', text: '重驱动到 DLQ' }, { id: 'y', text: 'DLQ 保留期更长' }, { id: 'z', text: '投递延迟' }] },
  ],
};
const result = {
  attemptId: ATTEMPT,
  labId: 'svc-queue',
  score: 50,
  correct: 1,
  total: 2,
  byDomain: { resilient: { correct: 1, total: 1 }, performance: { correct: 0, total: 1 } },
  results: [
    { id: 'q1', correct: true, given: ['b'], answer: ['b'], explain: '处理时间超过可见性超时会被重复处理。', relatesTo: 'enable-sqs' },
    { id: 'q2', correct: false, given: ['x'], answer: ['x', 'y'], explain: null, relatesTo: null },
  ],
};

function page(routes: Record<string, Response | ((c: unknown) => Response)> = {}) {
  return renderPage({
    path: '/labs/svc-queue/quiz',
    route: '/labs/:labId/quiz',
    element: <QuizPage />,
    routes: {
      'POST /api/v1/labs/svc-queue/quiz-attempts': json(201, start),
      [`PUT /api/v1/quiz-attempts/${ATTEMPT}/answers`]: json(200, { attemptId: ATTEMPT }),
      [`POST /api/v1/quiz-attempts/${ATTEMPT}/submit`]: json(200, result),
      ...routes,
    },
  });
}

describe('P03-Q 小测', () => {
  it('draws questions, autosaves each choice, and shows the accuracy (no pass/fail) after submitting', async () => {
    const { f, loc } = page();
    const group = await screen.findByRole('radiogroup', { name: '可见性超时应该怎么设？' });
    await waitFor(() => expect(loc()).toBe(`/labs/svc-queue/quiz?attempt=${ATTEMPT}`));
    expect(screen.getByText('第 1 / 2 题 · 弹性 · 单选')).toBeTruthy();
    const submit = screen.getByRole('button', { name: '交卷' });
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(within(group).getByRole('radio', { name: 'B. 大于最长处理时间' }));
    await waitFor(() => expect(callsOf(f, 'PUT', `/quiz-attempts/${ATTEMPT}/answers`)[0]!.body).toEqual({ answers: { q1: ['b'] } }));
    expect(await screen.findByText('作答已自动保存')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'A. 重驱动到 DLQ' }));
    await waitFor(() => expect(callsOf(f, 'PUT', `/quiz-attempts/${ATTEMPT}/answers`)).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: '交卷' }));
    const h = await screen.findByRole('heading', { level: 1, name: '小测结果：正确率 50%（1 / 2）' });
    await waitFor(() => expect(document.activeElement).toBe(h));
    expect(screen.queryByText(/及格/)).toBeNull();
    expect(screen.getByText(/正确答案：A、B。/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '回看步骤：接入 SQS' }).getAttribute('href')).toBe('/labs/svc-queue#steps');
    expect(sessionStorage.getItem('atl.quiz.v1.svc-queue')).toBeNull();
  });

  it('a failed save does not block answering and offers a retry', async () => {
    page({ [`PUT /api/v1/quiz-attempts/${ATTEMPT}/answers`]: json(503, { code: 'UPSTREAM_UNAVAILABLE', status: 503, title: 'x' }) });
    const group = await screen.findByRole('radiogroup');
    fireEvent.click(within(group).getByRole('radio', { name: 'A. 短轮询' }));
    expect(await screen.findByText(/作答未保存/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect((within(group).getByRole('radio', { name: 'A. 短轮询' }) as HTMLInputElement).checked).toBe(true);
  });

  it('resumes the attempt of this tab instead of drawing a new one', async () => {
    sessionStorage.setItem('atl.quiz.v1.svc-queue', JSON.stringify({ ...start, answers: { q1: ['a'] }, index: 1 }));
    const { f } = page();
    expect(await screen.findByText('第 2 / 2 题 · 高性能 · 多选')).toBeTruthy();
    expect(callsOf(f, 'POST', '/labs/svc-queue/quiz-attempts')).toHaveLength(0);
  });

  it('no quiz bank (404) and daily limit (429) have their own messages', async () => {
    const a = page({ 'POST /api/v1/labs/svc-queue/quiz-attempts': problem(404, 'NOT_FOUND') });
    expect(await screen.findByText('这张卡片暂时没有小测。')).toBeTruthy();
    a.unmount();
    page({ 'POST /api/v1/labs/svc-queue/quiz-attempts': problem(429, 'RATE_LIMITED') });
    expect(await screen.findByText('今天的作答次数已用完。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '返回简介页' }).getAttribute('href')).toBe('/labs/svc-queue');
  });
});
