/**
 * P03-Q 小测 `/labs/:labId/quiz?attempt=<attemptId>`（08 §4 P03-Q；04 §3.2.11），只对学员（路由守卫）。
 * - 进入时 POST /labs/{labId}/quiz-attempts（服务端抽题，不下发答案）；本次作答存在 sessionStorage，刷新页面后从 `attempt=` 继续，
 *   不重复消耗当日次数；
 * - 每次选择后自动保存 PUT /quiz-attempts/{attemptId}/answers（“作答未保存 · 重试”不阻止继续作答）；
 * - 交卷 POST /quiz-attempts/{attemptId}/submit → 结果页：只显示正确率与按领域正确率，不显示及格与否；焦点移到结果标题；
 * - 选项：单选是 role="radiogroup" 的原生单选按钮（方向键选择），多选是复选框；
 * - 当日次数用完（429）显示“今天的作答次数已用完”；卡片没有题库（404）显示“这张卡片暂时没有小测”。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { isApiError, type ApiError } from '../../api/errors';
import { useServices, useSessionSync } from '../../app/context';
import { t } from '../../i18n/zh-CN';
import { formatClock } from '../../lib/format';
import { ssGet, ssSet } from '../../lib/storage';
import { Button, EmptyState, ErrorPanel, Shape, Skeleton } from '../../ui';
import '../labs/catalog.css';
import { useCardIntro, useCatalog, useLabs } from '../labs/data';
import { isDoneStatus } from '../labs/model';
import { DOMAIN_TEXT } from '../labs/strings';
import type { QuizAttemptStart, QuizResult } from '../labs/types';
import { SS } from '../card/strings';

interface StoredAttempt extends QuizAttemptStart {
  answers: Record<string, string[]>;
  index: number;
}

const KEY = (labId: string) => `atl.quiz.v1.${labId}`;
const LETTERS = 'ABCDEFGH';

type Phase =
  | { kind: 'starting' }
  | { kind: 'answering'; attempt: StoredAttempt }
  | { kind: 'result'; attempt: StoredAttempt; result: QuizResult }
  | { kind: 'error'; error: ApiError; reason: 'none' | 'exhausted' | 'expired' | 'other' };

function domainText(d: string | undefined): string {
  return (d && DOMAIN_TEXT[d as keyof typeof DOMAIN_TEXT]) || d || '—';
}

export default function QuizPage() {
  const { labId = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const { api } = useServices();
  const { current } = useSessionSync();
  const catalog = useCatalog();
  const intro = useCardIntro(catalog.cards.has(labId) ? catalog.ref : null, labId);
  const labs = useLabs();
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [save, setSave] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [submitting, setSubmitting] = useState(false);
  const started = useRef(false);
  const resultRef = useRef<HTMLHeadingElement>(null);

  const start = useCallback(
    async (fresh: boolean) => {
      setPhase({ kind: 'starting' });
      const stored = fresh ? null : ssGet<StoredAttempt | null>(KEY(labId), null);
      const wanted = sp.get('attempt');
      if (stored && stored.labId === labId && (!wanted || wanted === stored.attemptId) && (!stored.deadlineAt || Date.parse(stored.deadlineAt) > Date.now())) {
        setPhase({ kind: 'answering', attempt: stored });
        if (wanted !== stored.attemptId) setSp({ attempt: stored.attemptId }, { replace: true });
        return;
      }
      try {
        const r = await api.call<QuizAttemptStart>('startQuizAttempt', { params: { labId } });
        if (!r.data) throw new Error('empty');
        const a: StoredAttempt = { ...r.data, answers: {}, index: 0 };
        ssSet(KEY(labId), a);
        setPhase({ kind: 'answering', attempt: a });
        setSp({ attempt: a.attemptId }, { replace: true });
      } catch (e) {
        if (!isApiError(e)) return;
        const reason = e.code === 'NOT_FOUND' ? 'none' : e.code === 'RATE_LIMITED' ? 'exhausted' : 'other';
        setPhase({ kind: 'error', error: e, reason });
      }
    },
    [api, labId, sp, setSp],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start(false);
  }, [start]);

  useEffect(() => {
    if (phase.kind === 'result') resultRef.current?.focus();
  }, [phase.kind]);

  const persist = (a: StoredAttempt) => {
    ssSet(KEY(labId), a);
    setPhase({ kind: 'answering', attempt: a });
  };

  const saveAnswers = async (a: StoredAttempt, qid: string) => {
    setSave('saving');
    try {
      await api.call('saveQuizAnswers', { params: { attemptId: a.attemptId }, body: { answers: { [qid]: a.answers[qid] ?? [] } } });
      setSave('saved');
    } catch (e) {
      if (isApiError(e) && e.code === 'INVALID_STATE') {
        ssSet(KEY(labId), undefined);
        setPhase({ kind: 'error', error: e, reason: 'expired' });
        return;
      }
      setSave('unsaved');
    }
  };

  const choose = (a: StoredAttempt, qid: string, optionId: string, multiple: boolean, checked: boolean) => {
    const cur = new Set(a.answers[qid] ?? []);
    if (multiple) {
      if (checked) cur.add(optionId);
      else cur.delete(optionId);
    } else {
      cur.clear();
      cur.add(optionId);
    }
    const next = { ...a, answers: { ...a.answers, [qid]: [...cur] } };
    persist(next);
    void saveAnswers(next, qid);
  };

  const submit = async (a: StoredAttempt) => {
    setSubmitting(true);
    try {
      // 最后一次保存失败时，交卷前补存全部作答
      if (save === 'unsaved') await api.call('saveQuizAnswers', { params: { attemptId: a.attemptId }, body: { answers: a.answers } });
      const r = await api.call<QuizResult>('submitQuizAttempt', { params: { attemptId: a.attemptId } });
      ssSet(KEY(labId), undefined);
      if (r.data) setPhase({ kind: 'result', attempt: a, result: r.data });
      void labs.reload();
    } catch (e) {
      if (isApiError(e) && e.code === 'INVALID_STATE') {
        ssSet(KEY(labId), undefined);
        setPhase({ kind: 'error', error: e, reason: 'expired' });
      } else setSave('unsaved');
    } finally {
      setSubmitting(false);
    }
  };

  const stepTitle = useMemo(() => new Map((intro.data?.steps ?? []).map((s) => [s.id, s.title])), [intro.data]);
  const crumbs = (
    <nav className="crumbs-nav" aria-label="面包屑">
      <ol>
        <li>
          <Link to="/labs">卡片目录</Link>
        </li>
        <li>
          <Link className="mono" to={`/labs/${labId}`}>
            {labId}
          </Link>
        </li>
        <li>{SS.page.quiz}</li>
      </ol>
    </nav>
  );

  if (phase.kind === 'starting') {
    return (
      <div className="stack-16 maxw-760" data-screen="P03-Q">
        {crumbs}
        <div className="ph">
          <h1 tabIndex={-1}>{t(SS.quiz.title, { id: labId })}</h1>
        </div>
        <Skeleton lines={4} label={SS.quiz.starting} />
      </div>
    );
  }

  if (phase.kind === 'error') {
    const text = phase.reason === 'none' ? SS.quiz.noQuiz : phase.reason === 'exhausted' ? SS.quiz.exhausted : phase.reason === 'expired' ? SS.quiz.expiredAttempt : null;
    return (
      <div className="stack-16 maxw-760" data-screen="P03-Q" data-quiz-error={phase.reason}>
        {crumbs}
        <div className="ph">
          <h1 tabIndex={-1}>{t(SS.quiz.title, { id: labId })}</h1>
        </div>
        {text ? (
          <EmptyState
            action={
              <>
                {phase.reason === 'expired' ? (
                  <Button variant="primary" onClick={() => void start(true)}>
                    {SS.quiz.again}
                  </Button>
                ) : null}
                <Link className="btn" to={`/labs/${labId}`}>
                  {SS.quiz.back}
                </Link>
              </>
            }
          >
            {text}
          </EmptyState>
        ) : (
          <ErrorPanel error={phase.error} onRetry={() => void start(false)} />
        )}
      </div>
    );
  }

  if (phase.kind === 'result') {
    const { result: r, attempt: a } = phase;
    const done = isDoneStatus(labs.data?.items.find((i) => i.labId === labId)?.status);
    const letters = (qid: string, ids: string[]) => {
      const q = a.questions.find((x) => x.id === qid);
      return ids.map((id) => LETTERS[q?.options.findIndex((o) => o.id === id) ?? -1] ?? id).join('、') || '—';
    };
    const live = current && current.labId === labId && ['READY', 'RUNNING', 'EXPIRING'].includes(current.state);
    return (
      <div className="stack-16 maxw-760 qz-res" data-screen="P03-Q" data-quiz-result="">
        {crumbs}
        <div className="ph">
          <h1 tabIndex={-1} ref={resultRef}>
            {t(SS.quiz.resultTitle, { pct: `${r.score}%`, c: r.correct, n: r.total })}
          </h1>
        </div>
        <p className="small muted">
          {done ? SS.quiz.recorded : SS.quiz.notYet}
          {SS.quiz.onlyRecord}
        </p>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{SS.quiz.domain}</th>
                <th scope="col" className="num">
                  {SS.quiz.rate}
                </th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(r.byDomain).map(([d, v]) => (
                <tr key={d}>
                  <td>{domainText(d)}</td>
                  <td className="num">
                    {v.correct} / {v.total}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {r.results.map((x, i) => {
          const q = a.questions.find((y) => y.id === x.id);
          return (
            <div key={x.id} className="box stack-8" data-q={x.id}>
              <div className="row">
                {x.correct ? (
                  <span className="st pass">
                    <Shape name="check" />
                    <span className="t">{SS.quiz.correct}</span>
                  </span>
                ) : (
                  <span className="st fail">
                    <Shape name="xbox" />
                    <span className="t">{SS.quiz.wrong}</span>
                  </span>
                )}
                <b>{t(SS.quiz.qNo, { i: i + 1 })}</b>
              </div>
              {q ? <p>{q.stem}</p> : null}
              <p className="small">
                {t(SS.quiz.yours, { list: letters(x.id, x.given) })} {t(SS.quiz.answer, { list: letters(x.id, x.answer) })}
                {x.explain ? ` ${x.explain}` : ''}
              </p>
              {x.relatesTo ? (
                <Link className="small" to={live ? `/workspace/${current!.sessionId}?step=${encodeURIComponent(x.relatesTo)}` : `/labs/${labId}#steps`}>
                  {t(SS.quiz.revisit, { step: stepTitle.get(x.relatesTo) ?? x.relatesTo })}
                </Link>
              ) : null}
            </div>
          );
        })}
        <div className="row">
          <Button onClick={() => void start(true)}>{SS.quiz.again}</Button>
          <Link className="btn ghost" to={`/labs/${labId}`}>
            {SS.quiz.back}
          </Link>
        </div>
      </div>
    );
  }

  const a = phase.attempt;
  const n = a.questions.length;
  const i = Math.min(a.index, n - 1);
  const q = a.questions[i]!;
  const multiple = q.type === 'multiple';
  const sel = a.answers[q.id] ?? [];
  const answered = a.questions.filter((x) => (a.answers[x.id] ?? []).length).length;
  const go = (d: number) => {
    persist({ ...a, index: Math.max(0, Math.min(n - 1, i + d)) });
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-qz-option]')?.focus());
  };
  return (
    <div className="stack-16 maxw-760" data-screen="P03-Q" data-attempt={a.attemptId}>
      {crumbs}
      <div className="ph">
        <div className="stack-4">
          <h1 tabIndex={-1}>{t(SS.quiz.title, { id: labId })}</h1>
          <span className="sub">{a.deadlineAt ? t(SS.quiz.subTimed, { n, at: formatClock(a.deadlineAt) }) : t(SS.quiz.sub, { n })}</span>
        </div>
        <span className="spacer" />
        <Link className="btn ghost" to={`/labs/${labId}`}>
          {SS.quiz.exit}
        </Link>
      </div>
      <fieldset className="box qz" role={multiple ? undefined : 'radiogroup'} aria-labelledby={`qz-stem-${q.id}`} aria-describedby={`qz-meta-${q.id}`}>
        <legend className="sr">{t(SS.quiz.qNo, { i: i + 1 })}</legend>
        <div className="small muted" id={`qz-meta-${q.id}`}>
          {t(SS.quiz.progress, { i: i + 1, n, domain: domainText(q.domain), type: multiple ? SS.quiz.multiple : SS.quiz.single })}
        </div>
        <p id={`qz-stem-${q.id}`}>
          <b>{q.stem}</b>
        </p>
        {q.options.map((o, j) => (
          <label key={o.id} className="chk qz-opt">
            <input
              type={multiple ? 'checkbox' : 'radio'}
              name={`qz-${q.id}`}
              value={o.id}
              checked={sel.includes(o.id)}
              data-qz-option={j === 0 ? '' : undefined}
              onChange={(e) => choose(a, q.id, o.id, multiple, e.target.checked)}
            />
            <span>
              {LETTERS[j]}. {o.text}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="row between">
        <span className={save === 'unsaved' ? 'small st fail' : 'small muted'} role="status">
          {save === 'saved' ? SS.quiz.saved : save === 'saving' ? SS.quiz.saving : SS.quiz.unsaved}
          {save === 'unsaved' ? (
            <>
              {' · '}
              <button type="button" className="linkbtn small" onClick={() => void saveAnswers(a, q.id)}>
                {SS.quiz.retrySave}
              </button>
            </>
          ) : null}
        </span>
        <div className="row">
          {i > 0 ? <Button onClick={() => go(-1)}>{SS.quiz.prev}</Button> : null}
          {i < n - 1 ? <Button onClick={() => go(1)}>{SS.quiz.next}</Button> : null}
        </div>
      </div>
      <hr className="rule" />
      <div className="row between">
        <span className="small muted">{SS.quiz.footer}</span>
        <Button
          variant="primary"
          busy={submitting}
          busyText={SS.quiz.submitting}
          disabledReason={answered < n ? t(SS.quiz.unanswered, { n: n - answered }) : null}
          onClick={() => void submit(a)}
          data-quiz-submit=""
        >
          {SS.quiz.submit}
        </Button>
      </div>
    </div>
  );
}
