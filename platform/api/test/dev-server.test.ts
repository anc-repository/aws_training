/**
 * The local dev server (src/dev-server.ts): Express ↔ Lambda event adapter, CORS for the front-end dev server,
 * `/content/*`, the lifecycle fallback, `/__dev/sessions/<sid>/advance` and seeding a content release from labs/.
 */
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createDevApp, functionForPath, seedDevCatalog } from '../src/dev-server.js';
import type { DevRuntime } from '../src/dev/runtime.js';
import { LEARNER, createApiTestRuntime, type ApiTestRuntime } from './api-support/api-runtime.js';
import { fixtureLab, fixtureQuiz } from './api-support/fixtures.js';
import { tmpDir } from './helpers.js';

function devApp(rt: ApiTestRuntime) {
  const fake = {
    invoker: rt.invoker,
    deps: rt.deps,
    env: rt.deps.env,
    objects: rt.objects,
    functions: {
      'atl-lifecycle': async () => {
        throw Object.assign(new Error('not yet'), { name: 'Atl.NotImplemented' });
      },
    },
  } as unknown as DevRuntime;
  return createDevApp(fake);
}

describe('dev server (Express adapter over the Lambda handlers)', () => {
  it('routes requests to the right function', () => {
    expect(functionForPath('GET', '/api/v1/agent/sessions/s4k7m2q9x1abc/context')).toBe('atl-agent');
    expect(functionForPath('POST', '/api/v1/internal/runs/s4k7m2q9x1abc-base-1/events')).toBe('atl-agent');
    expect(functionForPath('GET', '/api/v1/public/keys')).toBe('atl-public');
    expect(functionForPath('GET', '/api/v1/sessions/current')).toBe('atl-api');
    expect(functionForPath('GET', '/api/v1/unknown')).toBe('atl-api');
  });

  it('serves the API with CORS for local front-ends, content files and the dev controls', async () => {
    const rt = await createApiTestRuntime();
    const app = devApp(rt);
    const time = await request(app).get('/api/v1/time').set('authorization', `Bearer ${LEARNER}`).set('origin', 'http://localhost:5173');
    expect(time.status).toBe(200);
    expect(time.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(time.body.serverNow).toBe('2026-10-14T01:00:00.000Z');
    const pre = await request(app).options('/api/v1/sessions').set('origin', 'http://127.0.0.1:5173');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-headers']).toContain('idempotency-key');
    expect((await request(app).get('/api/v1/time').set('origin', 'https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();

    const index = await request(app).get('/content/2026.10.0/catalog/index.json');
    expect(index.status).toBe(200);
    expect(index.body.cards[0].id).toBe('svc-queue');
    expect((await request(app).get('/content/2026.10.0/nope.json')).status).toBe(404);

    // start a session through the adapter (the lifecycle fallback answers CreateSession)
    const quote = await request(app).post('/api/v1/labs/svc-queue/quotes').set('authorization', `Bearer ${LEARNER}`).set('idempotency-key', 'dev-quote-0001').send({ purpose: 'START' });
    expect(quote.status).toBe(201);
    const start = await request(app)
      .post('/api/v1/sessions')
      .set('authorization', `Bearer ${LEARNER}`)
      .set('idempotency-key', 'dev-start-0001')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ labId: 'svc-queue', quoteId: quote.body.quoteId, costAcknowledged: true }));
    expect(start.status).toBe(202);
    const sid = start.body.sessionId as string;
    expect(start.headers.location).toBe(`/api/v1/sessions/${sid}`);
    for (const to of ['PROVISIONING', 'READY']) {
      const adv = await request(app).post(`/__dev/sessions/${sid}/advance`).send({ to });
      expect(adv.status, JSON.stringify(adv.body)).toBe(200);
      expect(adv.body.state).toBe(to);
    }
    expect((await request(app).post(`/__dev/sessions/${sid}/advance`).send({ to: 'ENDED' })).status).toBe(409);
    const ctx = await request(app).get(`/api/v1/agent/sessions/${sid}/context`).set('x-atl-dev-caller', `arn:aws:sts::111122223333:assumed-role/ATLLearnerRole/atl-${sid}-ws`);
    expect(ctx.status).toBe(200);
    expect(ctx.body.schema).toBe('atl.agent-context/v1');
    const view = await request(app).get(`/api/v1/sessions/${sid}`).set('authorization', `Bearer ${LEARNER}`);
    expect(view.body).toMatchObject({ state: 'READY', allowedActions: ['extend', 'end', 'end-keep'] });
  });

  it('seeds a dev content release from labs/<id>/lab.yaml, quiz.yaml and _tracks', async () => {
    const rt = await createApiTestRuntime({ seed: false });
    const dir = tmpDir('labs-');
    fs.mkdirSync(path.join(dir, 'svc-queue'), { recursive: true });
    fs.mkdirSync(path.join(dir, '_tracks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'svc-queue', 'lab.yaml'), stringify(fixtureLab()));
    fs.writeFileSync(path.join(dir, 'svc-queue', 'quiz.yaml'), stringify(fixtureQuiz()));
    fs.writeFileSync(path.join(dir, '_tracks', 'saa-main.yaml'), stringify({ schema: 'atl.track/v2', id: 'saa-main', stages: [] }));
    const r = await seedDevCatalog(rt.deps, dir);
    expect(r).toEqual({ catalogVersion: 'dev', cards: ['svc-queue'], tracks: ['saa-main'] });
    expect((await rt.repos.platform.currentRelease())?.catalogVersion).toBe('dev');
    expect(await rt.objects.get(rt.deps.env.buckets.artifacts, 'releases/dev/private/quiz/svc-queue.json')).not.toBeNull();
    const app = devApp(rt);
    const lab = await request(app).get('/api/v1/labs/svc-queue').set('authorization', `Bearer ${LEARNER}`);
    expect(lab.status).toBe(200);
    expect(lab.body.catalogVersion).toBe('dev');
    expect(await seedDevCatalog(rt.deps, path.join(dir, 'missing'))).toEqual({ catalogVersion: 'dev', cards: [], tracks: [] });
  });
});
