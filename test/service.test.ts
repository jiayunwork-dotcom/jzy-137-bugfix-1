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
    expect(a.exceedsStrength, `cycle ${i} exceedsStrength`).toBe(e.exceedsStrength);
    // toBeCloseTo cannot compare infinities (Inf - Inf = NaN)
    if (Number.isFinite(e.damage)) {
      expect(a.damage, `cycle ${i} damage`).toBeCloseTo(e.damage, 10);
    } else {
      expect(a.damage, `cycle ${i} damage`).toBe(e.damage);
    }
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

describe('static-strength overload (Goodman mean >= UTS)', () => {
  const cfg = goodmanConfig(400); // C=1e12, m=3, UTS=400, hysteresis=0

  it('accepts a block containing overload cycles and lets the sequence advance', () => {
    // The reported failure, minimal example 1.
    const { service, store } = makeService();
    const id = service.createJob(cfg);

    service.appendBlock(id, 1, [0, 100, 0, 100, 0]);
    const after1 = service.getResult(id);
    expect(after1.cycles).toHaveLength(1);
    expect(after1.exceedsStrength).toBe(false);

    // Used to be rejected with a 400 and wedged the job; now accepted.
    const after2 = service.appendBlock(id, 2, [450, 500, 450, 500, 450, 0, 100]);
    expect(after2.lastSequence).toBe(2);
    expect(after2.cycles).toHaveLength(3);

    const overload = after2.cycles.filter((c) => c.exceedsStrength);
    expect(overload).toHaveLength(1);
    expect(overload[0]!.amplitude).toBeCloseTo(25, 12); // range 50
    expect(overload[0]!.mean).toBeCloseTo(475, 12);
    expect(overload[0]!.damage).toBe(Infinity);
    // Untouched cycles keep their exact Goodman damage.
    const normal = after2.cycles.filter((c) => !c.exceedsStrength);
    expect(normal).toHaveLength(2);
    for (const c of normal) {
      expect(c.amplitude).toBeCloseTo(50, 12);
      expect(c.mean).toBeCloseTo(50, 12);
      expect(c.damage).toBeCloseTo(Math.pow(50 / (1 - 50 / 400), 3) / 1e12, 15);
    }
    expect(after2.totalDamage).toBe(Infinity);
    expect(after2.exceedsStrength).toBe(true);

    // The next sequence number is accepted (used to answer 409).
    service.appendBlock(id, 3, [0, 200, 0]);
    expect(service.getResult(id).lastSequence).toBe(3);

    const done = service.finalize(id);
    expect(done.status).toBe('finalized');
    const ref = referencePipeline([0, 100, 0, 100, 0, 450, 500, 450, 500, 450, 0, 100, 0, 200, 0], cfg);
    approxCycles(done.cycles, ref.finalized);
    store.close();
  });

  it('treats a re-sent overload block as idempotent and still rejects a changed payload', () => {
    const { service, store } = makeService();
    const id = service.createJob(cfg);
    service.appendBlock(id, 1, [0, 100, 0, 100, 0]);
    service.appendBlock(id, 2, [450, 500, 450, 500, 450, 0, 100]);
    const before = service.getResult(id);

    // Identical re-submission of the block that used to be 400-rejected.
    const again = service.appendBlock(id, 2, [450, 500, 450, 500, 450, 0, 100]);
    expect(again.blocks).toBe(2);
    expect(again.cycles.length).toBe(before.cycles.length);
    expect(again.sampleCount).toBe(before.sampleCount);
    expect(again.totalDamage).toBe(Infinity);

    // Same sequence, different content is still a conflict.
    expect(() => service.appendBlock(id, 2, [1, 2, 3])).toThrow(ConflictError);
    store.close();
  });

  it('finalizes even when a residue half cycle exceeds the strength', () => {
    // The reported failure, minimal example 2: finalize used to answer 400
    // and the job stayed open forever.
    const { service, store } = makeService();
    const id = service.createJob(cfg);
    service.appendBlock(id, 1, [300, 500]);
    const done = service.finalize(id);
    expect(done.status).toBe('finalized');
    expect(done.cycles).toHaveLength(1);
    const half = done.cycles[0]!;
    expect(half.kind).toBe('half');
    expect(half.amplitude).toBeCloseTo(100, 12);
    expect(half.mean).toBeCloseTo(400, 12);
    expect(half.exceedsStrength).toBe(true);
    expect(half.damage).toBe(Infinity);
    expect(done.totalDamage).toBe(Infinity);
    expect(done.exceedsStrength).toBe(true);

    // Finalizing again stays idempotent.
    const twice = service.finalize(id);
    expect(twice.cycles).toHaveLength(1);
    expect(twice.totalDamage).toBe(Infinity);
    store.close();
  });

  it('is chunk-invariant: point-by-point, random cuts and one block agree with overloads present', () => {
    const rnd = mulberry32(4242);
    let sawOverload = 0;
    for (let trial = 0; trial < 30; trial++) {
      const n = 6 + Math.floor(rnd() * 120);
      // Offset the walk so that many cycle means land near/above UTS.
      const raw = randomWalk(rnd, n, 260).map((x) => x + 380);
      const config: JobConfig = { ...cfg, hysteresis: rnd() < 0.5 ? 0 : rnd() * 30 };
      const ref = referencePipeline(raw, config);
      if (ref.finalized.some((c) => c.exceedsStrength)) sawOverload++;

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
      feedChunks(c.service, jc, raw, randomCuts(rnd, n));
      const chunked = c.service.finalize(jc);
      c.store.close();

      approxCycles(whole.cycles, ref.finalized);
      approxCycles(pbp.cycles, ref.finalized);
      approxCycles(chunked.cycles, ref.finalized);

      const refTotal = ref.finalized.reduce((s, x) => s + x.damage, 0);
      for (const r of [whole, pbp, chunked]) {
        expect(r.exceedsStrength).toBe(ref.finalized.some((x) => x.exceedsStrength));
        if (Number.isFinite(refTotal)) expect(r.totalDamage).toBeCloseTo(refTotal, 9);
        else expect(r.totalDamage).toBe(refTotal);
      }
    }
    // The test is only meaningful if overloads actually occurred.
    expect(sawOverload).toBeGreaterThan(0);
  });

  it('survives a restart after an overload block was committed', () => {
    const raw = [0, 100, 0, 100, 0, 450, 500, 450, 500, 450, 0, 100, 0, 200, 0];
    const { service, dbPath } = makeService();
    const id = service.createJob(cfg);
    service.appendBlock(id, 1, raw.slice(0, 5));
    service.appendBlock(id, 2, raw.slice(5, 12)); // commits overload cycles
    service.store.close();

    // Restart on the same file: infinite damage must round-trip through SQLite.
    const store2 = new JobStore(dbPath);
    const service2 = new JobService(store2);
    const mid = service2.getResult(id);
    expect(mid.status).toBe('open');
    expect(mid.totalDamage).toBe(Infinity);
    expect(mid.exceedsStrength).toBe(true);
    expect(mid.cycles.filter((c) => c.exceedsStrength)).toHaveLength(1);

    service2.appendBlock(id, 3, raw.slice(12));
    const done = service2.finalize(id);

    const ref = referencePipeline(raw, cfg);
    approxCycles(done.cycles, ref.finalized);
    expect(done.totalDamage).toBe(Infinity);
    store2.close();
  });

  it('leaves correction-none jobs untouched by the same overload signal', () => {
    const { service, store } = makeService();
    const id = service.createJob(baseConfig); // correction 'none', no UTS
    service.appendBlock(id, 1, [300, 500]);
    const done = service.finalize(id);
    expect(done.cycles).toHaveLength(1);
    const half = done.cycles[0]!;
    expect(half.exceedsStrength).toBe(false);
    expect(half.damage).toBeCloseTo((0.5 * Math.pow(100, 3)) / 1e12, 15);
    expect(done.exceedsStrength).toBe(false);
    expect(Number.isFinite(done.totalDamage)).toBe(true);
    store.close();
  });
});
