import { describe, expect, it } from 'vitest';
import { allowedMethods, matchRoute, routeById, ROUTES, UI_REQUESTED_ROUTES } from '../src/index.js';

describe('route table (01 §8.2)', () => {
  it('ids and method+path pairs are unique', () => {
    expect(new Set(ROUTES.map((r) => r.id)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(ROUTES.length);
  });

  it('auth codes are consistent with the route family', () => {
    for (const r of ROUTES) {
      if (r.kind === 'agent') expect(r.auth).toEqual(['WS']);
      else if (r.kind === 'internal') expect(r.auth).toEqual(['RUN']);
      else if (r.kind === 'public') expect(r.auth).toEqual(['PUBLIC']);
      else if (r.kind === 'agent-fallback') expect(r.auth).toEqual(['RUN_TOKEN']);
      else for (const a of r.auth) expect(['L', 'A', 'O']).toContain(a);
    }
  });

  it('every POST and PUT …/result needs an Idempotency-Key', () => {
    for (const r of ROUTES) {
      if (r.method === 'POST') expect(r.idempotent).toBe(true);
      if (r.method === 'GET') expect(r.idempotent).toBe(false);
    }
    expect(routeById('agentPutExperimentResult').idempotent).toBe(true);
    expect(routeById('putVar').idempotent).toBe(false);
  });

  it('maps families to functions', () => {
    expect(routeById('createSession').fn).toBe('atl-api');
    expect(routeById('agentGetContext').fn).toBe('atl-agent');
    expect(routeById('internalRunEvents').fn).toBe('atl-agent');
    expect(routeById('publicHealth').fn).toBe('atl-public');
  });

  it('assistant-only and observer-free routes follow the RBAC matrix (01 §5.2)', () => {
    expect(routeById('reviewManualConfirmation').auth).toEqual(['A']);
    expect(routeById('createStepCheckRun').auth).toEqual(['L', 'A']);
    expect(routeById('createConsoleLink').auth).toEqual(['L']);
    expect(routeById('listAuditEvents').auth).toEqual(['L', 'A']);
    for (const id of ['createConsoleLink', 'createTerminal', 'getAppCredentials', 'issueCertificate', 'requestModuleOp', 'prepareUninstall']) {
      expect(routeById(id).recentAuth, id).toBe(true);
    }
  });

  it('matches paths with and without the prefix; static segments win', () => {
    expect(matchRoute('GET', '/api/v1/sessions/current')?.route.id).toBe('getCurrentSession');
    expect(matchRoute('GET', '/sessions/s4k7m2q9x1abc')).toMatchObject({ route: { id: 'getSession' }, params: { sid: 's4k7m2q9x1abc' } });
    expect(matchRoute('GET', '/api/v1/experiment-runs/compare?a=1&b=2')?.route.id).toBe('compareExperimentRuns');
    expect(matchRoute('GET', '/api/v1/experiment-runs/01ABC')?.route.id).toBe('getExperimentRun');
    expect(matchRoute('get', '/api/v1/agent/sessions/s4k7m2q9x1abc/context')?.route.id).toBe('agentGetContext');
    expect(matchRoute('PUT', '/api/v1/agent/sessions/s4k7m2q9x1abc/experiment-runs/R1/result')?.params).toEqual({
      sid: 's4k7m2q9x1abc',
      runId: 'R1',
    });
    expect(matchRoute('DELETE', '/api/v1/sessions/s4k7m2q9x1abc/steps/a-step/skip')?.route.id).toBe('unskipStep');
    expect(matchRoute('POST', '/api/v1/sessions/s4k7m2q9x1abc/steps/a-step/skip')?.route.id).toBe('skipStep');
    expect(matchRoute('GET', '/api/v1/nope')).toBeNull();
    expect(matchRoute('PUT', '/api/v1/me')).toBeNull();
    expect(allowedMethods('/api/v1/me').sort()).toEqual(['GET', 'PATCH']);
  });

  it('does not contain deprecated paths or unregistered UI requests', () => {
    expect(matchRoute('GET', '/api/v1/sessions/active')?.route.id).toBe('getSession'); // treated as {sid}; handler validates the sid
    expect(matchRoute('POST', '/api/v1/sessions/s4k7m2q9x1abc/keep')).toBeNull();
    for (const r of UI_REQUESTED_ROUTES) {
      const m = matchRoute(r.method, r.path.replace(/\{[^}]+\}/g, 'x'));
      // none of them may resolve to a route with the same path template
      if (m) expect(m.route.path).not.toBe(r.path);
    }
  });
});
