import { createHash } from 'node:crypto';
import { ConflictError, JobConfig, JobResult, Cycle } from '../core/types';
import { PeakValleyExtractor, pushBlock } from '../core/peakvalley';
import { RainflowAccumulator, pushTurningPoints } from '../core/rainflow';
import { scoreCycle, sumDamage, validateMaterial } from '../core/damage';
import { JobStore, StoredCycle } from '../store/sqliteStore';

/** Stable checksum so a repeated (sequence, payload) is recognised as idempotent. */
export function checksumPoints(points: readonly number[]): string {
  return createHash('sha256').update(points.join(',')).digest('hex');
}

function toCycle(c: StoredCycle): Cycle {
  return {
    amplitude: c.amplitude,
    mean: c.mean,
    count: c.count,
    damage: c.damage,
    kind: c.kind,
  };
}

export class JobService {
  constructor(readonly store: JobStore) {}

  createJob(config: JobConfig): string {
    validateMaterial(config);
    return this.store.createJob(config);
  }

  /**
   * Append one block.
   *
   * Sequence numbers start at 1 and must be contiguous; a gap is rejected. A
   * repeated sequence with an IDENTICAL payload is idempotent and returns the
   * result as it stands; a repeated sequence with a different payload is a
   * conflict.
   */
  appendBlock(jobId: string, sequence: number, values: unknown): JobResult {
    const state = this.store.getEngineState(jobId);
    const { points, duplicate } = this.store.validateBlock(
      jobId,
      state.status,
      state.lastSequence,
      sequence,
      values,
    );
    const checksum = checksumPoints(points);

    if (duplicate) {
      const block = this.store.getBlockChecksum(jobId, sequence);
      if (block?.checksum !== checksum) {
        throw new ConflictError(
          `sequence ${sequence} already exists with different content`,
        );
      }
      return this.getResult(jobId); // idempotent re-submission
    }

    // Rebuild the streaming reducers from the persisted residual state and
    // process ONLY the new points. Cross-block cycles live entirely in the
    // peak/valley residual + rainflow stack, which are persisted after each
    // append.
    const pv = new PeakValleyExtractor(state.config.hysteresis, state.pv);
    const rf = new RainflowAccumulator(state.stack);

    const turning = pushBlock(pv, points);
    const rawFull = pushTurningPoints(rf, turning);
    const newCycles = rawFull.map((r) => {
      const scored = scoreCycle(r, state.config);
      return {
        amplitude: scored.amplitude,
        mean: scored.mean,
        count: scored.count,
        damage: scored.damage,
        kind: scored.kind as 'full',
      };
    });

    const totalDamage = state.totalDamage + sumDamage(newCycles);

    this.store.commitAppend({
      jobId,
      sequence,
      checksum,
      pointCount: points.length,
      pv: pv.getState(),
      stack: rf.getStack(),
      newCycles,
      totalDamage,
    });

    return this.getResult(jobId);
  }

  /**
   * Explicitly close a job. The held-open final extremum is flushed through the
   * reducers and the rainflow residue is folded into HALF cycles. Half cycles
   * are never present before this point. Finalizing twice is idempotent.
   */
  finalize(jobId: string): JobResult {
    const state = this.store.getEngineState(jobId);
    if (state.status === 'finalized') return this.getResult(jobId);

    const pv = new PeakValleyExtractor(state.config.hysteresis, state.pv);
    const rf = new RainflowAccumulator(state.stack);

    const tail = pv.flush();
    // The flushed point may still close full cycles; count those as full.
    const tailFull = pushTurningPoints(rf, tail);
    const scoredFull = tailFull.map((r) => scoreCycle(r, state.config));
    // Whatever remains is the residue -> half cycles.
    const rawHalf = rf.residualHalfCycles();
    const scoredHalf = rawHalf.map((r) => scoreCycle(r, state.config));

    const added = [...scoredFull, ...scoredHalf].map((c) => ({
      amplitude: c.amplitude,
      mean: c.mean,
      count: c.count,
      damage: c.damage,
      kind: c.kind,
    }));
    const totalDamage = state.totalDamage + sumDamage(added);

    this.store.commitFinalize(jobId, pv.getState(), rf.getStack(), added, totalDamage);
    return this.getResult(jobId);
  }

  getResult(jobId: string): JobResult {
    const state = this.store.getEngineState(jobId);
    const stored = this.store.listCycles(jobId);
    const cycles = stored.map(toCycle);
    return {
      jobId,
      status: state.status,
      blocks: this.store.countBlocks(jobId),
      lastSequence: state.lastSequence,
      sampleCount: state.sampleCount,
      cycles,
      // recompute from stored cycles so the answer never drifts from the rows
      totalDamage: sumDamage(cycles),
    };
  }
}
