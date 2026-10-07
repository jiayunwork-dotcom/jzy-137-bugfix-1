import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { JobService } from '../src/service/jobService';
import { JobStore } from '../src/store/sqliteStore';
import {
  baseConfig,
  goodmanConfig,
  makeService,
  mulberry32,
  randomCuts,
  randomWalk,
  referencePipeline,
} from './helpers';
import { Cycle, JobConfig } from '../src/core/types';
import { ConflictError, ValidationError } from '../src/core/types';

/** Append `raw` to a job in the chunks implied by `cuts` (boundaries). */
function feedChunks(service: JobService, jobId: string, raw: number[], cuts: number[]): void {
  let start = 0;
  let seq = 1;
  for (const end of cuts) {
    service.appendBlock(jobId, seq, raw.slice(start, end));
    start = end;
    seq++;
  }
}

function approxCycles(actual: Cycle[], expected: Cycle[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i]!;
    const e = expected[i]!;
    expect(a.amplitude, `cycle ${i} amplitude`).toBeCloseTo(e.amplitude, 9);
    expect(a.mean, `cycle ${i} mean`).toBeCloseTo(e.mean, 9);
    expect(a.count, `cycle ${i} count`).toBeCloseTo(e.count, 12);
    expect(a.kind, `cycle ${i} kind`).toBe(e.kind);
    expect(a.overload, `cycle ${i} overload`).toBe(e.overload);
    expect(a.damage, `cycle ${i} damage`).toBeCloseTo(e.damage, 10);
  }
}

describe('streaming job service — chunk invariance', () => {
  it('point-by-point, random chunks and one block give identical results after finalize', () => {
    const rnd = mulberry32(31337);
    for (let trial = 0; trial < 60; trial++) {
      const n = 6 + Math.floor(rnd() * 140);
      const raw = randomWalk(rnd, n, 14);
      const config: JobConfig = {
        ...baseConfig,
        hysteresis: rnd() < 0.4 ? 0 : rnd() * 4,
      };
      const ref = referencePipeline(raw, config);

      // one whole block
      const w = makeService();
      const jw = w.service.createJob(config);
      w.service.appendBlock(jw, 1, raw);
      const whole = w.service.finalize(jw);
      w.store.close();

      // point by point
      const p = makeService();
      const jp = p.service.createJob(config);
      feedChunks(p.service, jp, raw, raw.map((_, i) => i + 1));
      const pbp = p.service.finalize(jp);
      p.store.close();

      // random chunks
      const c = makeService();
      const jc = c.service.createJob(config);
      feedChunks(c.service, jc, raw, randomCuts(rnd, n));
      const chunked = c.service.finalize(jc);
      c.store.close();

      approxCycles(whole.cycles, ref.finalized);
      approxCycles(pbp.cycles, ref.finalized);
      approxCycles(chunked.cycles, ref.finalized);
      expect(whole.totalDamage).toBeCloseTo(ref.finalized.reduce((s, x) => s + x.damage, 0), 9);
    }
  });

  it('handles a block boundary exactly on a peak', () => {
    // The peak value 50 is the last sample of block 1.
    const raw = [0, 20, 50, 20, 0, -40, -10];
    const { service, store } = makeService();
    const id = service.createJob(baseConfig);
    service.appendBlock(id, 1, raw.slice(0, 3)); // ends exactly on the peak
    service.appendBlock(id, 2, raw.slice(3));
    const r = service.finalize(id);
    const ref = referencePipeline(raw, baseConfig);
    approxCycles(r.cycles, ref.finalized);
    store.close();
  });

  it('handles a block containing a single point', () => {
    const raw = [0, 10, -10, 20, -20, 5];
    const { service, store } = makeService();
    const id = service.createJob(baseConfig);
    let seq = 1;
    for (const p of raw) service.appendBlock(id, seq++, [p]);
    const r = service.finalize(id);
    const ref = referencePipeline(raw, baseConfig);
    approxCycles(r.cycles, ref.finalized);
    store.close();
  });

  it('handles blocks that are entirely constant', () => {
    const raw = [5, 5, 5, 10, 10, 0, 0, 0, 7, 7];
    const { service, store } = makeService();
    const id = service.createJob(baseConfig);
    service.appendBlock(id, 1, [5, 5]);
    service.appendBlock(id, 2, [5, 10, 10]);
    service.appendBlock(id, 3, [0, 0, 0]);
    service.appendBlock(id, 4, [7, 7]);
    const r = service.finalize(id);
    const ref = referencePipeline(raw, baseConfig);
    approxCycles(r.cycles, ref.finalized);
    store.close();
  });

  it('a wholly constant history yields no cycles and zero damage', () => {
    const { service, store } = makeService();
    const id = service.createJob(baseConfig);
    service.appendBlock(id, 1, [4, 4, 4]);
    expect(service.getResult(id).cycles).toEqual([]);
    const r = service.finalize(id);
    expect(r.cycles).toEqual([]);
    expect(r.totalDamage).toBe(0);
    store.close();
  });
});

describe('intermediate queries before finalization', () => {
  it('count only deterministic full cycles; residue excluded until finalize', () => {
    const raw = randomWalk(mulberry32(55), 60, 16);
    const config = baseConfig;
    const ref = referencePipeline(raw, config);

    const { service, store } = makeService();
    const id = service.createJob(config);

    // feed first ~40% and query
    const cut = 24;
    const prefix = raw.slice(0, cut);
    service.appendBlock(id, 1, prefix);
    const mid = service.getResult(id);
    const refMid = referencePipeline(prefix, config);
    approxCycles(mid.cycles, refMid.streamingFull);
    // everything before finalize is a full cycle and no half cycle exists
    expect(mid.cycles.every((c) => c.kind === 'full')).toBe(true);
    expect(mid.totalDamage).toBeCloseTo(
      refMid.streamingFull.reduce((s, c) => s + c.damage, 0),
      10,
    );

    // finish and finalize -> residue now folded into half cycles
    service.appendBlock(id, 2, raw.slice(cut));
    const done = service.finalize(id);
    approxCycles(done.cycles, ref.finalized);
    expect(done.cycles.some((c) => c.kind === 'half')).toBe(true);
    store.close();
  });

  it('finalizing twice is idempotent and does not double-count', () => {
    const raw = randomWalk(mulberry32(77), 40, 12);
    const { service, store } = makeService();
    const id = service.createJob(baseConfig);
    service.appendBlock(id, 1, raw);
    const once = service.finalize(id);
    const twice = service.finalize(id);
    expect(twice.cycles.length).toBe(once.cycles.length);
    expect(twice.totalDamage).toBeCloseTo(once.totalDamage, 12);
    expect(twice.status).toBe('finalized');
    store.close();
  });

  it('rejects appends after finalization', () => {
    const { service, store } = makeService();
    const id = service.createJob(baseConfig);
    service.appendBlock(id, 1, [0, 1, 2]);
    service.finalize(id);
    expect(() => service.appendBlock(id, 2, [3, 4])).toThrow(ConflictError);
    store.close();
  });
});

describe('sequence numbering and idempotency', () => {
  it('rejects a gap in sequence numbers', () => {
    const { service, store } = makeService();
    const id = service.createJob(baseConfig);
    service.appendBlock(id, 1, [0, 1]);
    expect(() => service.appendBlock(id, 3, [2, 3])).toThrow(ConflictError);
    store.close();
  });

  it('rejects a repeated sequence with different content', () => {
    const { service, store } = makeService();
    const id = service.createJob(baseConfig);
    service.appendBlock(id, 1, [0, 1, 2]);
    expect(() => service.appendBlock(id, 1, [9, 9, 9])).toThrow(ConflictError);
    store.close();
  });

  it('treats the same sequence with the same content as idempotent', () => {
    const { service, store } = makeService();
    const id = service.createJob(baseConfig);
    service.appendBlock(id, 1, [0, 10, -10]);
    const before = service.getResult(id);
    const again = service.appendBlock(id, 1, [0, 10, -10]); // exact repeat
    expect(again.cycles.length).toBe(before.cycles.length);
    expect(again.sampleCount).toBe(before.sampleCount);
    expect(again.blocks).toBe(1);
    // and the next sequence is still accepted
    service.appendBlock(id, 2, [5, -5]);
    expect(service.getResult(id).blocks).toBe(2);
    store.close();
  });

  it('rejects non-positive / non-integer sequence', () => {
    const { service, store } = makeService();
    const id = service.createJob(baseConfig);
    expect(() => service.appendBlock(id, 0, [1])).toThrow(ValidationError);
    expect(() => service.appendBlock(id, 1.5, [1])).toThrow(ValidationError);
    store.close();
  });
});

describe('restart recovery', () => {
  it('continues appending after reopening the same SQLite file', () => {
    const raw = randomWalk(mulberry32(2025), 80, 15);
    const { service, dbPath } = makeService();
    const id = service.createJob(baseConfig);
    // append a prefix, then "crash" (close handles without finalizing)
    service.appendBlock(id, 1, raw.slice(0, 30));
    service.appendBlock(id, 2, raw.slice(30, 47));
    service.store.close();

    // restart: new store/service over the same file
    const store2 = new JobStore(dbPath);
    const service2 = new JobService(store2);
    const mid = service2.getResult(id);
    expect(mid.status).toBe('open');
    service2.appendBlock(id, 3, raw.slice(47));
    const done = service2.finalize(id);

    const ref = referencePipeline(raw, baseConfig);
    approxCycles(done.cycles, ref.finalized);
    expect(done.sampleCount).toBe(raw.length);
    store2.close();
  });
});

describe('block validation errors', () => {
  it('rejects non-arrays, NaN/Infinity, empty and oversized blocks', () => {
    const { service, store } = makeService();
    const id = service.createJob(baseConfig);
    expect(() => service.appendBlock(id, 1, 'nope' as unknown)).toThrow(ValidationError);
    expect(() => service.appendBlock(id, 1, [1, NaN, 3] as unknown)).toThrow(ValidationError);
    expect(() => service.appendBlock(id, 1, [1, Infinity] as unknown)).toThrow(ValidationError);
    expect(() => service.appendBlock(id, 1, [] as unknown)).toThrow(ValidationError);
    expect(() =>
      service.appendBlock(id, 1, new Array(200_001).fill(0) as unknown),
    ).toThrow(/limit is 200000/);
    store.close();
  });

  it('accepts a block of exactly 200000 points', () => {
    const { service, store } = makeService();
    const id = service.createJob(baseConfig);
    const pts = new Array(200_000).fill(0).map((_, i) => (i % 2 === 0 ? 1 : -1));
    service.appendBlock(id, 1, pts);
    expect(service.getResult(id).sampleCount).toBe(200_000);
    store.close();
  });
});

describe('Goodman through the service', () => {
  it('compressive-mean cycles are not enlarged vs the none-correction run', () => {
    // A signal centered well below zero so every mean is compressive.
    const raw = [-1000, -960, -1040, -940, -1060, -980];
    const none = makeService();
    const jn = none.service.createJob({ ...baseConfig, correction: 'none' });
    none.service.appendBlock(jn, 1, raw);
    const rn = none.service.finalize(jn);
    none.store.close();

    const gm = makeService();
    const jg = gm.service.createJob(goodmanConfig(2000));
    gm.service.appendBlock(jg, 1, raw);
    const rg = gm.service.finalize(jg);
    gm.store.close();

    expect(rg.cycles.length).toBe(rn.cycles.length);
    for (let i = 0; i < rn.cycles.length; i++) {
      expect(rg.cycles[i]!.damage).toBeCloseTo(rn.cycles[i]!.damage, 12);
    }
  });
});

describe('Goodman overload (mean meets/exceeds UTS)', () => {
  const cfg = () => goodmanConfig(400); // C=1e12, m=3, UTS=400, hysteresis=0
  // The colleague's stuck history: normal 0..100 cycles, then an excursion
  // oscillating between 450 and 500 (cycle mean 475 >= UTS 400).
  const BLOCK1 = [0, 100, 0, 100, 0];
  const OVERLOAD_BLOCK = [450, 500, 450, 500, 450, 0, 100];
  const BLOCK3 = [0, 50, 0];

  it('accepts a block containing an overload cycle and keeps the sequence moving', () => {
    const { service, store } = makeService();
    const id = service.createJob(cfg());
    service.appendBlock(id, 1, BLOCK1);
    const r2 = service.appendBlock(id, 2, OVERLOAD_BLOCK); // previously a 400

    // the overload cycle is visible in the query, flagged, with finite damage
    const overload = r2.cycles.filter((c) => c.overload);
    expect(overload).toHaveLength(1);
    expect(overload[0]!.kind).toBe('full');
    expect(overload[0]!.mean).toBeCloseTo(475, 12);
    expect(overload[0]!.amplitude).toBeCloseTo(25, 12);
    expect(overload[0]!.damage).toBe(1); // count weight: Miner failure sum

    // the non-overload cycles are scored exactly as before (plain Goodman)
    const normal = r2.cycles.filter((c) => !c.overload);
    expect(normal).toHaveLength(2);
    const want = Math.pow(50 / (1 - 50 / 400), 3) / 1e12;
    for (const c of normal) {
      expect(c.amplitude).toBeCloseTo(50, 12);
      expect(c.mean).toBeCloseTo(50, 12);
      expect(c.damage).toBeCloseTo(want, 18);
    }

    // the stream is not wedged: the next sequence is accepted, finalize works
    service.appendBlock(id, 3, BLOCK3);
    expect(service.getResult(id).lastSequence).toBe(3);
    const done = service.finalize(id);
    expect(done.status).toBe('finalized');
    expect(done.totalDamage).toBeGreaterThan(1); // overload pushed it past failure
    expect(Number.isFinite(done.totalDamage)).toBe(true);
    store.close();
  });

  it('finalizes cleanly when a residue half cycle overloads (mean exactly UTS)', () => {
    const { service, store } = makeService();
    const id = service.createJob(cfg());
    service.appendBlock(id, 1, [300, 500]); // accepted; nothing counted yet
    const done = service.finalize(id); // previously a 400, job stuck open
    expect(done.status).toBe('finalized');
    expect(done.cycles).toHaveLength(1);
    const c = done.cycles[0]!;
    expect(c.kind).toBe('half');
    expect(c.overload).toBe(true);
    expect(c.mean).toBeCloseTo(400, 12);
    expect(c.amplitude).toBeCloseTo(100, 12);
    expect(c.damage).toBe(0.5); // half of the failure weight
    expect(done.totalDamage).toBeCloseTo(0.5, 15);
    store.close();
  });

  it('is chunk-invariant: point-by-point, random chunks and one block agree', () => {
    const raw = [...BLOCK1, ...OVERLOAD_BLOCK, ...BLOCK3];
    const config = cfg();
    const ref = referencePipeline(raw, config);
    expect(ref.finalized.some((c) => c.overload)).toBe(true);

    const w = makeService();
    const jw = w.service.createJob(config);
    w.service.appendBlock(jw, 1, raw);
    const whole = w.service.finalize(jw);
    w.store.close();

    const p = makeService();
    const jp = p.service.createJob(config);
    feedChunks(p.service, jp, raw, raw.map((_, i) => i + 1));
    const pbp = p.service.finalize(jp);
    p.store.close();

    const c = makeService();
    const jc = c.service.createJob(config);
    feedChunks(c.service, jc, raw, randomCuts(mulberry32(424242), raw.length));
    const chunked = c.service.finalize(jc);
    c.store.close();

    approxCycles(whole.cycles, ref.finalized);
    approxCycles(pbp.cycles, ref.finalized);
    approxCycles(chunked.cycles, ref.finalized);
    const wantTotal = ref.finalized.reduce((s, x) => s + x.damage, 0);
    expect(whole.totalDamage).toBeCloseTo(wantTotal, 9);
    expect(pbp.totalDamage).toBeCloseTo(wantTotal, 9);
    expect(chunked.totalDamage).toBeCloseTo(wantTotal, 9);
  });

  it('treats a re-sent overload block as idempotent, not an error', () => {
    const { service, store } = makeService();
    const id = service.createJob(cfg());
    service.appendBlock(id, 1, BLOCK1);
    service.appendBlock(id, 2, OVERLOAD_BLOCK);
    const before = service.getResult(id);

    const again = service.appendBlock(id, 2, OVERLOAD_BLOCK); // exact repeat
    expect(again.cycles.length).toBe(before.cycles.length);
    expect(again.totalDamage).toBeCloseTo(before.totalDamage, 15);
    expect(again.blocks).toBe(2);
    expect(again.lastSequence).toBe(2);

    // same sequence with different content still conflicts
    expect(() => service.appendBlock(id, 2, [1, 2, 3])).toThrow(ConflictError);
    // and the stream moves on afterwards
    service.appendBlock(id, 3, BLOCK3);
    expect(service.getResult(id).lastSequence).toBe(3);
    store.close();
  });

  it('resumes after a restart with the same result as an uninterrupted run', () => {
    const { service, dbPath } = makeService();
    const id = service.createJob(cfg());
    service.appendBlock(id, 1, BLOCK1);
    service.appendBlock(id, 2, OVERLOAD_BLOCK); // overload already ingested
    service.store.close(); // "crash" with the job open

    const store2 = new JobStore(dbPath);
    const service2 = new JobService(store2);
    service2.appendBlock(id, 3, BLOCK3);
    const done = service2.finalize(id);

    const plain = makeService();
    const jid = plain.service.createJob(cfg());
    plain.service.appendBlock(jid, 1, BLOCK1);
    plain.service.appendBlock(jid, 2, OVERLOAD_BLOCK);
    plain.service.appendBlock(jid, 3, BLOCK3);
    const expected = plain.service.finalize(jid);
    plain.store.close();

    approxCycles(done.cycles, expected.cycles);
    expect(done.totalDamage).toBeCloseTo(expected.totalDamage, 12);
    expect(done.cycles.some((c) => c.overload)).toBe(true);
    store2.close();
  });

  it('does not affect jobs without the Goodman correction', () => {
    const { service, store } = makeService();
    const id = service.createJob({ ...baseConfig, correction: 'none' }); // no UTS at all
    service.appendBlock(id, 1, [450, 500, 450, 500, 450]);
    const r = service.finalize(id);
    expect(r.cycles.length).toBeGreaterThan(0);
    for (const c of r.cycles) {
      expect(c.overload).toBe(false);
      expect(c.damage).toBeCloseTo((c.count * Math.pow(c.amplitude, 3)) / 1e12, 15);
    }
    store.close();
  });

  it('migrates a pre-overload-schema database in place', () => {
    // Simulate the colleague's stuck database: current schema minus the
    // overload column, holding only the blocks accepted before the upgrade.
    const { service, store, dbPath } = makeService();
    const id = service.createJob(cfg());
    service.appendBlock(id, 1, BLOCK1);
    store.close();
    const raw = new Database(dbPath);
    raw.exec('ALTER TABLE cycles DROP COLUMN overload');
    raw.close();

    // Reopening with the new binary adds the column; old rows read as
    // non-overload (they could only be non-overload back then), and the
    // previously rejected overload block now lands.
    const store2 = new JobStore(dbPath);
    const service2 = new JobService(store2);
    const before = service2.getResult(id);
    expect(before.cycles).toHaveLength(1);
    expect(before.cycles[0]!.overload).toBe(false);
    service2.appendBlock(id, 2, OVERLOAD_BLOCK);
    const after = service2.finalize(id);
    expect(after.cycles.some((c) => c.overload)).toBe(true);
    expect(after.status).toBe('finalized');
    store2.close();
  });
});
