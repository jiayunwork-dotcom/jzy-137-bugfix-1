import { describe, expect, it } from 'vitest';
import { RainflowAccumulator, pushTurningPoints } from '../src/core/rainflow';

/**
 * ASTM E1049-85, Appendix X5 worked example.
 *
 * Turning-point sequence (X5.1):
 *   -2, 1, -3, 5, -1, 3, -4, 4, -2
 *
 * The standard's results table (X1.1), expressed here as amplitude / mean /
 * count:
 *   full cycle : range 4, mean 1, count 1
 *   half cycles: ranges 3,4,8,9,8,6 with means -0.5,-1,1,0.5,0,1, each 0.5
 */
const ASTM_SEQUENCE = [-2, 1, -3, 5, -1, 3, -4, 4, -2];

const EXPECTED_FULL: Array<[number, number, number]> = [
  [4, 1, 1], // range, mean, count
];

const EXPECTED_HALF: Array<[number, number, number]> = [
  [3, -0.5, 0.5],
  [4, -1, 0.5],
  [8, 1, 0.5],
  [9, 0.5, 0.5],
  [8, 0, 0.5],
  [6, 1, 0.5],
];

describe('ASTM E1049 X5 worked example', () => {
  it('reproduces the published table row by row', () => {
    const rf = new RainflowAccumulator();
    const full = pushTurningPoints(rf, ASTM_SEQUENCE);
    const half = rf.residualHalfCycles();

    expect(full.map((c) => [c.range, c.mean, c.count])).toEqual(EXPECTED_FULL);
    expect(half.map((c) => [c.range, c.mean, c.count])).toEqual(EXPECTED_HALF);

    // Bookkeeping: one full + six half cycles.
    const totalCounts =
      full.reduce((s, c) => s + c.count, 0) +
      half.reduce((s, c) => s + c.count, 0);
    expect(totalCounts).toBeCloseTo(4, 10); // (n-1)/2 = 4 for n = 9 points
  });

  it('matches when points are fed one at a time with a serialized stack', () => {
    const rf = new RainflowAccumulator();
    let full: ReturnType<RainflowAccumulator['push']> = [];
    for (const p of ASTM_SEQUENCE) {
      full = [...full, ...rf.push(p)];
    }
    const half = rf.residualHalfCycles();
    expect(full.map((c) => [c.range, c.mean, c.count])).toEqual(EXPECTED_FULL);
    expect(half.map((c) => [c.range, c.mean, c.count])).toEqual(EXPECTED_HALF);
  });
});
