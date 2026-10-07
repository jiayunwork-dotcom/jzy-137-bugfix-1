import { ConfigError } from './types';
import type { JobConfig, Cycle } from './types';
import type { RawCycle } from './rainflow';

/**
 * Palmgren-Miner linear damage accumulation with a Basquin S-N curve.
 *
 *     N(S) = C * S^(-m)   =>   damage of one cycle at effective amplitude S
 *                              is 1 / N(S) = S^m / C
 *
 * The effective amplitude is the cycle amplitude (range/2) with an optional
 * mean-stress correction:
 *
 *   none    : S = amplitude
 *   goodman : S = amplitude / (1 - mean / UTS)
 *
 * Goodman is applied only for a tensile (positive) mean. For a compressive
 * (mean <= 0) mean the amplitude is NOT enlarged, so S stays equal to the
 * amplitude.
 *
 * OVERLOAD (Goodman only): a cycle whose mean meets/exceeds the ultimate
 * tensile strength has crossed the static strength of the material — the
 * Goodman denominator 1 - mean/UTS is <= 0 and no finite life exists. Such a
 * cycle is DATA, not an error (overload excursions happen in real tests and
 * must not wedge the ingest stream):
 *
 *   - the cycle is counted and stored like any other, flagged `overload: true`;
 *   - its damage contribution is recorded as exactly its count weight
 *     (1 for a full cycle, 0.5 for a residue half cycle): the Miner sum
 *     reaches 1.0 at failure, so one overload full cycle already exhausts the
 *     life budget;
 *   - the accumulated total is NOT capped at 1 — later cycles keep
 *     accumulating and the stored total always equals the sum of the rows.
 *
 * Rejected alternatives: rejecting the block loses real measurements and
 * wedges the sequence stream; recording Infinity is not representable in JSON
 * (it serialises to null) and breaks downstream sums; recording a fabricated
 * finite "huge" number or clamping the mean below UTS invents precision the
 * model does not have. See the README for the full trade-off discussion.
 */

export interface DamageInput {
  C: number;
  m: number;
  correction: 'none' | 'goodman';
  ultimateTensileStrength?: number;
}

export function validateMaterial(cfg: JobConfig): void {
  if (!Number.isFinite(cfg.C) || cfg.C <= 0) {
    throw new ConfigError('S-N coefficient C must be a finite positive number');
  }
  if (!Number.isFinite(cfg.m) || cfg.m <= 0) {
    throw new ConfigError('S-N exponent m must be a finite positive number');
  }
  if (!Number.isFinite(cfg.hysteresis) || cfg.hysteresis < 0) {
    throw new ConfigError('hysteresis must be a finite non-negative number');
  }
  if (cfg.correction !== 'none' && cfg.correction !== 'goodman') {
    throw new ConfigError(`unknown correction: ${String(cfg.correction)}`);
  }
  if (cfg.correction === 'goodman') {
    if (
      cfg.ultimateTensileStrength === undefined ||
      !Number.isFinite(cfg.ultimateTensileStrength) ||
      cfg.ultimateTensileStrength <= 0
    ) {
      throw new ConfigError('Goodman correction requires a positive ultimate tensile strength');
    }
  }
}

/**
 * True when a cycle's mean meets/exceeds the ultimate tensile strength under
 * Goodman: the excursion crossed the static strength and no finite Goodman
 * life exists. Always false without the Goodman correction.
 */
export function isOverload(mean: number, cfg: DamageInput): boolean {
  return cfg.correction === 'goodman' && mean >= (cfg.ultimateTensileStrength as number);
}

/**
 * Effective (mean-corrected) amplitude for one cycle. For an overload cycle
 * (see `isOverload`) no finite effective amplitude exists; returns Infinity.
 * Callers that need a finite damage number must special-case overload, as
 * `cycleDamage` does.
 */
export function effectiveAmplitude(
  amplitude: number,
  mean: number,
  cfg: DamageInput,
): number {
  if (cfg.correction === 'goodman') {
    const uts = cfg.ultimateTensileStrength as number;
    if (mean > 0) {
      const denom = 1 - mean / uts;
      if (denom <= 0) {
        return Infinity; // overload: static failure, zero remaining life
      }
      return amplitude / denom;
    }
    // Compressive (or zero) mean: do not enlarge the amplitude.
    return amplitude;
  }
  return amplitude;
}

/**
 * Damage for a single cycle application, including the 0.5 half-cycle weight.
 * An overload cycle contributes exactly its count weight: the Miner failure
 * sum is 1, and one static-failure excursion exhausts it per full cycle.
 */
export function cycleDamage(
  amplitude: number,
  mean: number,
  count: number,
  cfg: DamageInput,
): number {
  if (isOverload(mean, cfg)) return count;
  const S = effectiveAmplitude(amplitude, mean, cfg);
  return (count * Math.pow(S, cfg.m)) / cfg.C;
}

/** Convert a geometry-only raw cycle into a fully scored Cycle. */
export function scoreCycle(raw: RawCycle, cfg: JobConfig): Cycle {
  const amplitude = raw.range / 2;
  return {
    amplitude,
    mean: raw.mean,
    count: raw.count,
    damage: cycleDamage(amplitude, raw.mean, raw.count, cfg),
    kind: raw.kind,
    overload: isOverload(raw.mean, cfg),
  };
}

export function sumDamage(cycles: readonly Cycle[]): number {
  let total = 0;
  for (const c of cycles) total += c.damage;
  return total;
}
