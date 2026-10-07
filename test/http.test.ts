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

  it('accepts overload blocks, advances the sequence and marks them explicitly', async () => {
    // Reported failure, minimal example 1: C=1e12, m=3, Goodman, UTS=400.
    const b = app();
    const created = await b.app.inject({
      method: 'POST',
      url: '/jobs',
      payload: { C: 1e12, m: 3, correction: 'goodman', ultimateTensileStrength: 400, hysteresis: 0 },
    });
    expect(created.statusCode).toBe(201);
    const { jobId } = created.json() as { jobId: string };

    const r1 = await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      payload: { sequence: 1, values: [0, 100, 0, 100, 0] },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().exceedsStrength).toBe(false);

    // The block whose cycle means swing between 450 and 500: used to be a 400.
    const r2 = await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      payload: { sequence: 2, values: [450, 500, 450, 500, 450, 0, 100] },
    });
    expect(r2.statusCode).toBe(200);
    const body2 = r2.json();
    expect(body2.lastSequence).toBe(2);
    expect(body2.exceedsStrength).toBe(true);
    expect(body2.totalDamage).toBe('Infinity');
    const flagged = body2.cycles.filter((c: { exceedsStrength: boolean }) => c.exceedsStrength);
    expect(flagged.length).toBeGreaterThan(0);
    for (const c of flagged) {
      expect(c.damage).toBe('Infinity');
      expect(typeof c.amplitude).toBe('number');
      expect(typeof c.mean).toBe('number');
    }
    // Untouched cycles still carry plain finite numbers.
    const plain = body2.cycles.filter((c: { exceedsStrength: boolean }) => !c.exceedsStrength);
    for (const c of plain) expect(typeof c.damage).toBe('number');

    // The next sequence goes through (used to be a 409)...
    const r3 = await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      payload: { sequence: 3, values: [0, 200, 0] },
    });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().lastSequence).toBe(3);

    // ...and re-sending the overload block verbatim is idempotent (was a 400).
    const dup = await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      payload: { sequence: 2, values: [450, 500, 450, 500, 450, 0, 100] },
    });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().blocks).toBe(3);
    expect(dup.json().cycles.length).toBe(r3.json().cycles.length);

    const fin = await b.app.inject({ method: 'POST', url: `/jobs/${jobId}/finalize` });
    expect(fin.statusCode).toBe(200);
    expect(fin.json().status).toBe('finalized');
    expect(fin.json().totalDamage).toBe('Infinity');

    const get = await b.app.inject({ method: 'GET', url: `/jobs/${jobId}` });
    expect(get.json().exceedsStrength).toBe(true);
    expect(get.json().totalDamage).toBe('Infinity');
  });

  it('finalizes a job whose residue half cycle exceeds the strength', async () => {
    // Reported failure, minimal example 2: finalize used to answer 400 and
    // the job stayed open forever.
    const b = app();
    const created = await b.app.inject({
      method: 'POST',
      url: '/jobs',
      payload: { C: 1e12, m: 3, correction: 'goodman', ultimateTensileStrength: 400, hysteresis: 0 },
    });
    const { jobId } = created.json() as { jobId: string };

    const r1 = await b.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/blocks`,
      payload: { sequence: 1, values: [300, 500] },
    });
    expect(r1.statusCode).toBe(200);

    const fin = await b.app.inject({ method: 'POST', url: `/jobs/${jobId}/finalize` });
    expect(fin.statusCode).toBe(200);
    const done = fin.json();
    expect(done.status).toBe('finalized');
    expect(done.cycles).toHaveLength(1);
    expect(done.cycles[0].kind).toBe('half');
    expect(done.cycles[0].mean).toBeCloseTo(400, 9);
    expect(done.cycles[0].exceedsStrength).toBe(true);
    expect(done.cycles[0].damage).toBe('Infinity');
    expect(done.totalDamage).toBe('Infinity');
  });
});
