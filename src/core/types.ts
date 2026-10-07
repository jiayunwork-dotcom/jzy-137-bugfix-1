/**
 * Shared domain types for the streaming rainflow service.
 */

/** Mean-stress correction used when converting a cycle into an effective amplitude. */
export type MeanStressCorrection = 'none' | 'goodman';

export interface MaterialConfig {
  /** Basquin fatigue-strength coefficient: N = C * S^(-m). */
  C: number;
  /** Basquin exponent (positive). */
  m: number;
  /**
   * Ultimate tensile strength, required for Goodman correction.
   * Must be strictly positive when correction === 'goodman'.
   */
  ultimateTensileStrength?: number;
  /** Mean-stress correction model. */
  correction: MeanStressCorrection;
}

/**
 * Per-job configuration.
 *
 * `hysteresis` is given in *amplitude* units: a peak-to-valley swing is kept
 * only when its amplitude (range / 2) is greater than or equal to the
 * threshold, i.e. the raw range must be >= 2 * hysteresis. Set 0 to disable
 * filtering. It is applied during peak/valley extraction, *before* rainflow
 * counting, exactly as required.
 */
export interface JobConfig extends MaterialConfig {
  hysteresis: number;
}

export type JobStatus = 'open' | 'finalized';

/** A counted cycle (full cycles carry count 1; residue half cycles carry 0.5). */
export interface Cycle {
  /** Stress amplitude = range / 2. */
  amplitude: number;
  /** Stress mean = (peak + valley) / 2. */
  mean: number;
  /** 1 for a full cycle, 0.5 for a residue half cycle. */
  count: number;
  /**
   * Palmgren-Miner damage contributed by this cycle. For an `overload` cycle
   * this is exactly `count` (the Miner failure weight); see `overload`.
   */
  damage: number;
  /** 'full' while streaming; 'half' is only produced at finalization. */
  kind: 'full' | 'half';
  /**
   * Goodman only: true when the cycle mean meets/exceeds the ultimate tensile
   * strength — the excursion crossed the static strength, so no finite Goodman
   * life exists. The cycle is still counted and stored (overload is data, not
   * an error). Always false with correction 'none'.
   */
  overload: boolean;
}

export interface JobResult {
  jobId: string;
  status: JobStatus;
  blocks: number;
  /** Last accepted sequence number; null when no block has been accepted. */
  lastSequence: number | null;
  /** Number of raw samples accepted so far. */
  sampleCount: number;
  cycles: Cycle[];
  /** Sum of per-cycle damage (computed from the stored cycles). */
  totalDamage: number;
}

export class ConfigError extends Error {}
export class ValidationError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}
