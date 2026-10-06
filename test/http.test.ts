import { describe, expect, it, afterEach } from 'vitest';
import { buildApp, BuiltApp } from '../src/http/app';
import { tempDbPath, randomWalk, mulberry32, baseConfig, referencePipeline } from './helpers';

let built: BuiltApp | null = null;

function app(): BuiltApp {
  built = buildApp({ dbPath: tempDbPath(), logger: false });
  return built;
}

afterEach(() => {
  built?.store.close();
  built = null;
});

describe('HTTP API', () => {
  it('health', async () => {
    const b = app();
    const res = await b.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('creates a job, appends chunks, queries and finalizes', async () => {
    const b = app();
    const created = await b.app.inject({
      method: 'POST',
      url: '/jobs',
      payload: baseConfig,
    });
    expect(created.statusCode).toBe(201);
    const { jobId } = created.json() as { jobId: string };

    const raw = randomWalk(mulberry32(9), 50, 12);
    const cut = 20;
    const r1 = await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      payload: { sequence: 1, values: raw.slice(0, cut) },
    });
    expect(r1.statusCode).toBe(200);
    const mid = r1.json();
    expect(mid.status).toBe('open');
    expect(mid.cycles.every((c: { kind: string }) => c.kind === 'full')).toBe(true);
    expect(mid.blocks).toBe(1);

    const r2 = await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      payload: { sequence: 2, values: raw.slice(cut) },
    });
    expect(r2.statusCode).toBe(200);

    const fin = await b.app.inject({ method: 'POST', url: `/jobs/${jobId}/finalize` });
    expect(fin.statusCode).toBe(200);
    const done = fin.json();
    expect(done.status).toBe('finalized');

    const ref = referencePipeline(raw, baseConfig);
    expect(done.cycles.length).toBe(ref.finalized.length);
    for (let i = 0; i < ref.finalized.length; i++) {
      expect(done.cycles[i].amplitude).toBeCloseTo(ref.finalized[i]!.amplitude, 9);
      expect(done.cycles[i].mean).toBeCloseTo(ref.finalized[i]!.mean, 9);
      expect(done.cycles[i].count).toBeCloseTo(ref.finalized[i]!.count, 12);
    }

    // GET mirrors the result
    const get = await b.app.inject({ method: 'GET', url: `/jobs/${jobId}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().totalDamage).toBeCloseTo(done.totalDamage, 12);
  });

  it('returns 400 for invalid config and bad blocks', async () => {
    const b = app();
    const badCfg = await b.app.inject({
      method: 'POST',
      url: '/jobs',
      payload: { ...baseConfig, correction: 'goodman' /* missing UTS */ },
    });
    expect(badCfg.statusCode).toBe(400);

    const ok = await b.app.inject({ method: 'POST', url: '/jobs', payload: baseConfig });
    const { jobId } = ok.json() as { jobId: string };

    const nan = await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      payload: { sequence: 1, values: [1, NaN] },
    });
    expect(nan.statusCode).toBe(400);

    const empty = await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      payload: { sequence: 1, values: [] },
    });
    expect(empty.statusCode).toBe(400);

    // JSON.stringify(NaN) -> null: a non-finite/non-number element is a 400.
    const nullEl = await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      payload: { sequence: 1, values: [1, NaN, 3] },
    });
    expect(nullEl.statusCode).toBe(400);

    // A malformed JSON body (bare NaN token is not valid JSON) is also a 400.
    const malformed = await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      headers: { 'content-type': 'application/json' },
      payload: '{\"sequence\":1,\"values\":[1,NaN,3]}',
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('returns 404 for unknown job', async () => {
    const b = app();
    const res = await b.app.inject({ method: 'GET', url: '/jobs/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 for a gap and for duplicate sequence with different content', async () => {
    const b = app();
    const created = await b.app.inject({ method: 'POST', url: '/jobs', payload: baseConfig });
    const { jobId } = created.json() as { jobId: string };

    await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      payload: { sequence: 1, values: [0, 1, 2] },
    });

    const gap = await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      payload: { sequence: 3, values: [0, 1] },
    });
    expect(gap.statusCode).toBe(409);

    const dup = await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      payload: { sequence: 1, values: [9, 8] },
    });
    expect(dup.statusCode).toBe(409);

    // idempotent repeat of identical content -> 200
    const same = await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      payload: { sequence: 1, values: [0, 1, 2] },
    });
    expect(same.statusCode).toBe(200);
  });
});
