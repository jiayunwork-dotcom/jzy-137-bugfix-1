import { describe, expect, it } from 'vitest';
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
