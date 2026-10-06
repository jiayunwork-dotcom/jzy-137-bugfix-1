import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeakValleyExtractor, pushBlock } from '../src/core/peakvalley';
import {
  RainflowAccumulator,
  pushTurningPoints,
  offlineRainflow,
  RawCycle,
} from '../src/core/rainflow';
import { scoreCycle } from '../src/core/damage';
import { Cycle, JobConfig } from '../src/core/types';
import { JobStore } from '../src/store/sqliteStore';
import { JobService } from '../src/service/jobService';

export function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rainflow-'));
  return join(dir, 'test.db');
}

export function makeService(dbPath?: string): { service: JobService; store: JobStore; dbPath: string } {
  const path = dbPath ?? tempDbPath();
  const store = new JobStore(path);
  const service = new JobService(store);
  return { service, store, dbPath: path };
}

export const baseConfig: JobConfig = {
  C: 1e12,
  m: 3,
  correction: 'none',
  hysteresis: 0,
};

export function goodmanConfig(uts = 1000): JobConfig {
  return { C: 1e12, m: 3, correction: 'goodman', ultimateTensileStrength: uts, hysteresis: 0 };
}

/** Deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random raw stress walk. */
export function randomWalk(rnd: () => number, n: number, scale = 10): number[] {
  const out: number[] = [];
  let v = 0;
  for (let i = 0; i < n; i++) {
    v += (rnd() - 0.5) * scale;
    out.push(v);
  }
  return out;
}

/** Random cut boundaries including n, for chunking a series. */
export function randomCuts(rnd: () => number, n: number): number[] {
  const set = new Set<number>();
  const count = Math.floor(rnd() * n);
  for (let i = 0; i < count; i++) set.add(1 + Math.floor(rnd() * (n - 1)));
  set.add(n);
  return [...set].sort((a, b) => a - b);
}

export interface ReferenceResult {
  /** Full cycles deterministically counted WITHOUT flushing the tail. */
  streamingFull: Cycle[];
  /** Everything after flush + residue folding. */
  finalized: Cycle[];
  turningPoints: number[];
}

/**
 * Independent in-memory reference: feed the entire raw history through the
 * reducers in one go. `streamingFull` is what an intermediate query (before
 * finalization) must show; `finalized` is what finalize must produce.
 */
export function referencePipeline(raw: number[], config: JobConfig): ReferenceResult {
  const pvWhole = new PeakValleyExtractor(config.hysteresis);
  const tp = pushBlock(pvWhole, raw);

  const pvStream = new PeakValleyExtractor(config.hysteresis);
  const rfStream = new RainflowAccumulator();
  const streamRaw = pushTurningPoints(rfStream, pushBlock(pvStream, raw));
  const streamingFull = streamRaw.map((r) => scoreCycle(r, config));

  const pvFin = new PeakValleyExtractor(config.hysteresis);
  const rfFin = new RainflowAccumulator();
  const full = pushTurningPoints(rfFin, pushBlock(pvFin, raw));
  const tail = pvFin.flush();
  const tailFull = pushTurningPoints(rfFin, tail);
  const half = rfFin.residualHalfCycles();
  const finalized = [...full, ...tailFull, ...half].map((r) => scoreCycle(r, config));

  return { streamingFull, finalized, turningPoints: tp };
}

export { offlineRainflow };
export type { RawCycle };
