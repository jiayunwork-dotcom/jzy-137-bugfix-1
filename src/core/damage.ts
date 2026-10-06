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
 * amplitude. A mean meeting/exceeding the tensile strength is non-physical and
 * raises an error rather than producing an infinite/negative life.
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

/** Effective (mean-corrected) amplitude for one cycle. */
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
        throw new ConfigError(
          `cycle mean ${mean} meets/exceeds ultimate tensile strength ${uts}; Goodman life undefined`,
        );
      }
      return amplitude / denom;
    }
    // Compressive (or zero) mean: do not enlarge the amplitude.
    return amplitude;
  }
  return amplitude;
}

/** Damage for a single cycle application, including the 0.5 half-cycle weight. */
export function cycleDamage(
  amplitude: number,
  mean: number,
  count: number,
  cfg: DamageInput,
): number {
  const S = effectiveAmplitude(amplitude, mean, cfg);
  return (count * Math.pow(S, cfg.m)) / cfg.C;
}

/** Convert a geometry-only raw cycle into a fully scored Cycle. */
export function scoreCycle(raw: RawCycle, cfg: JobConfig): Cycle {
  const amplitude = raw.range / 2;
  const damage = cycleDamage(amplitude, raw.mean, raw.count, cfg);
  return { amplitude, mean: raw.mean, count: raw.count, damage, kind: raw.kind };
}

export function sumDamage(cycles: readonly Cycle[]): number {
  let total = 0;
  for (const c of cycles) total += c.damage;
  return total;
}
