import { describe, expect, it } from 'vitest';
import {
  effectiveAmplitude,
  cycleDamage,
  validateMaterial,
  sumDamage,
  scoreCycle,
} from '../src/core/damage';
import { RawCycle, offlineRainflow } from '../src/core/rainflow';
import { Cycle } from '../src/core/types';
import { baseConfig, goodmanConfig } from './helpers';
import { ConfigError } from '../src/core/types';

describe('damage / Basquin', () => {
  it('damage = S^m / C with no correction', () => {
    expect(cycleDamage(10, 0, 1, baseConfig)).toBeCloseTo(Math.pow(10, 3) / 1e12, 15);
  });

  it('weights half cycles by 0.5', () => {
    const full = cycleDamage(10, 0, 1, baseConfig);
    const half = cycleDamage(10, 0, 0.5, baseConfig);
    expect(half).toBeCloseTo(full / 2, 15);
  });

  it('amplitude is range/2', () => {
    const raw: RawCycle = { range: 20, mean: 5, count: 1, kind: 'full' };
    expect(scoreCycle(raw, baseConfig).amplitude).toBe(10);
    expect(scoreCycle(raw, baseConfig).mean).toBe(5);
  });

  it('sumDamage adds per-cycle damage', () => {
    const cycles = [scoreCycle({ range: 20, mean: 0, count: 1, kind: 'full' }, baseConfig)];
    expect(sumDamage(cycles)).toBeCloseTo(cycles[0]!.damage, 15);
  });
});

describe('Goodman mean-stress correction', () => {
  it('enlarges amplitude for tensile mean', () => {
    const cfg = goodmanConfig(1000);
    // S = a / (1 - mean/UTS)
    expect(effectiveAmplitude(100, 250, cfg)).toBeCloseTo(100 / 0.75, 12);
  });

  it('does NOT enlarge amplitude for compressive (or zero) mean', () => {
    const cfg = goodmanConfig(1000);
    expect(effectiveAmplitude(100, -300, cfg)).toBe(100);
    expect(effectiveAmplitude(100, 0, cfg)).toBe(100);
  });

  it('raises when mean reaches the tensile strength', () => {
    const cfg = goodmanConfig(1000);
    expect(() => effectiveAmplitude(100, 1000, cfg)).toThrow(ConfigError);
    expect(() => effectiveAmplitude(100, 1200, cfg)).toThrow(ConfigError);
  });

  it('requires ultimateTensileStrength', () => {
    expect(() =>
      validateMaterial({ C: 1, m: 2, correction: 'goodman', hysteresis: 0 }),
    ).toThrow(/ultimate tensile strength/i);
  });
});

describe('config validation', () => {
  it('rejects non-positive C and m', () => {
    expect(() => validateMaterial({ ...baseConfig, C: 0 })).toThrow(ConfigError);
    expect(() => validateMaterial({ ...baseConfig, C: NaN })).toThrow(ConfigError);
    expect(() => validateMaterial({ ...baseConfig, m: -1 })).toThrow(ConfigError);
    expect(() => validateMaterial({ ...baseConfig, m: Infinity })).toThrow(ConfigError);
  });

  it('rejects negative or non-finite hysteresis', () => {
    expect(() => validateMaterial({ ...baseConfig, hysteresis: -1 })).toThrow(ConfigError);
    expect(() => validateMaterial({ ...baseConfig, hysteresis: NaN })).toThrow(ConfigError);
  });
});

describe('signal transformations (hysteresis = 0, no correction)', () => {
  // Build cycles from a fixed turning-point history.
  const raw = [0, 40, -20, 60, 10, -50, 30, -10, 20];

  function cyclesOf(signal: number[]): Cycle[] {
    return offlineRainflow(signal).map((r) => scoreCycle(r, baseConfig));
  }

  it('doubling the signal doubles amplitude and mean; damage scales by 2^m', () => {
    const a = cyclesOf(raw);
    const b = cyclesOf(raw.map((x) => 2 * x));
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) {
      expect(b[i]!.amplitude).toBeCloseTo(2 * a[i]!.amplitude, 12);
      expect(b[i]!.mean).toBeCloseTo(2 * a[i]!.mean, 12);
      expect(b[i]!.damage).toBeCloseTo(a[i]!.damage * 2 ** baseConfig.m, 12);
    }
    expect(sumDamage(b)).toBeCloseTo(sumDamage(a) * 2 ** baseConfig.m, 10);
  });

  it('a constant offset shifts means but leaves amplitude and damage unchanged', () => {
    const k = 123.456;
    const a = cyclesOf(raw);
    const b = cyclesOf(raw.map((x) => x + k));
    for (let i = 0; i < a.length; i++) {
      expect(b[i]!.amplitude).toBeCloseTo(a[i]!.amplitude, 12);
      expect(b[i]!.mean).toBeCloseTo(a[i]!.mean + k, 10);
      expect(b[i]!.damage).toBeCloseTo(a[i]!.damage, 12);
    }
  });

  it('negation preserves amplitude, negates mean', () => {
    const a = cyclesOf(raw);
    const b = cyclesOf(raw.map((x) => -x));
    const norm = (list: Cycle[]) =>
      list
        .map((c) => `${c.amplitude.toFixed(9)}:${c.mean.toFixed(9)}:${c.count}:${c.kind}`)
        .sort();
    // Negated signal: same (amplitude,count,kind) multiset, means negated.
    const aKey = norm(a).map((s) => s.replace(/:-?\d+.*?:/, '::')); // strip mean loosely
    void aKey;
    const bByAmplitude = new Map<string, number[]>();
    for (const c of b) {
      const k = c.amplitude.toFixed(9);
      const arr = bByAmplitude.get(k) ?? [];
      arr.push(c.mean);
      bByAmplitude.set(k, arr);
    }
    expect(b.length).toBe(a.length);
    for (const ca of a) {
      const arr = bByAmplitude.get(ca.amplitude.toFixed(9))!;
      const want = -ca.mean;
      const idx = arr.findIndex((m) => Math.abs(m - want) < 1e-9);
      expect(idx).toBeGreaterThanOrEqual(0);
      arr.splice(idx, 1);
    }
    for (const arr of bByAmplitude.values()) expect(arr).toHaveLength(0);
  });
});
