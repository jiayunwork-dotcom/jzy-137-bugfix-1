import { describe, expect, it } from 'vitest';
import {
  PeakValleyExtractor,
  pushBlock,
  initialPeakValleyState,
} from '../src/core/peakvalley';
import {
  RainflowAccumulator,
  pushTurningPoints,
  offlineRainflow,
} from '../src/core/rainflow';
import { mulberry32 } from './helpers';

/** Extract turning points of a complete history (hysteresis = 0 by default). */
function turningPoints(raw: number[], hyst = 0): number[] {
  const pv = new PeakValleyExtractor(hyst);
  const out = pushBlock(pv, raw);
  return [...out, ...pv.flush()];
}

describe('peak/valley extraction', () => {
  it('merges same-direction points and keeps extrema', () => {
    // monotonic runs collapse to the end points; one reversal chain
    expect(turningPoints([0, 1, 2, 3, 2, 1, 0, -1, 0])).toEqual([0, 3, -1, 0]);
  });

  it('de-duplicates plateaus', () => {
    expect(turningPoints([5, 5, 5, 6, 6, 4, 4])).toEqual([5, 6, 4]);
    expect(turningPoints([3, 3, 3, 3])).toEqual([3]);
  });

  it('emits nothing for a single point before flush and the point at flush', () => {
    const pv = new PeakValleyExtractor(0);
    expect(pushBlock(pv, [7])).toEqual([]);
    expect(pv.flush()).toEqual([7]);
  });

  it('filters swings below the hysteresis amplitude threshold', () => {
    // threshold amplitude 1 => keep only swings with range >= 2
    const raw = [0, 3, 2, 3, 2, 0, -3];
    // 0->3 (kept), ±1 wiggles inside band removed, 3->-3 kept
    expect(turningPoints(raw, 1)).toEqual([0, 3, -3]);
  });

  it('is a left fold: serialized state reproduces one-shot processing', () => {
    const rnd = mulberry32(7);
    for (let t = 0; t < 300; t++) {
      const n = 4 + Math.floor(rnd() * 90);
      const raw = Array.from({ length: n }, () => (rnd() - 0.5) * 20);
      const hyst = rnd() < 0.5 ? 0 : rnd() * 5;
      const whole = turningPoints(raw, hyst);

      // feed in two halves, persisting and restoring state across the cut
      const cut = 1 + Math.floor(rnd() * (n - 1));
      const pv = new PeakValleyExtractor(hyst);
      const first = pushBlock(pv, raw.slice(0, cut));
      const restored = new PeakValleyExtractor(hyst, pv.getState());
      const second = pushBlock(restored, raw.slice(cut));
      const chunked = [...first, ...second, ...restored.flush()];
      expect(chunked).toEqual(whole);
    }
  });

  it('rejects non-finite samples', () => {
    const pv = new PeakValleyExtractor(0);
    expect(() => pv.push(NaN)).toThrow(/finite/);
    expect(() => pv.push(Infinity)).toThrow(/finite/);
  });

  it('initial state is serializable', () => {
    expect(initialPeakValleyState().mode).toBe('empty');
  });
});

describe('rainflow kernel vs offline reference', () => {
  it('agrees with the offline implementation on random alternating series', () => {
    const rnd = mulberry32(99);
    let fails = 0;
    for (let t = 0; t < 2000; t++) {
      const n = 3 + Math.floor(rnd() * 40);
      const pts: number[] = [];
      let v = 0;
      let dir = rnd() < 0.5 ? 1 : -1;
      for (let i = 0; i < n; i++) {
        v += dir * (1 + Math.floor(rnd() * 10));
        pts.push(v);
        dir = -dir;
      }
      const rf = new RainflowAccumulator();
      const online = [...pushTurningPoints(rf, pts), ...rf.residualHalfCycles()];
      const offline = offlineRainflow(pts);
      expect(bag(online)).toEqual(bag(offline));
      if (fails) break;
    }
  });

  it('chunking the turning points leaves cycle order identical', () => {
    const rnd = mulberry32(2024);
    for (let t = 0; t < 200; t++) {
      const n = 6 + Math.floor(rnd() * 50);
      const pts: number[] = [];
      let v = 0;
      let dir = rnd() < 0.5 ? 1 : -1;
      for (let i = 0; i < n; i++) {
        v += dir * (1 + Math.floor(rnd() * 10));
        pts.push(v);
        dir = -dir;
      }
      const rfWhole = new RainflowAccumulator();
      const wholeFull = pushTurningPoints(rfWhole, pts);

      const cut = 1 + Math.floor(rnd() * (pts.length - 1));
      const rf = new RainflowAccumulator();
      const f1 = pushTurningPoints(rf, pts.slice(0, cut));
      const rf2 = new RainflowAccumulator(rf.getStack());
      const f2 = pushTurningPoints(rf2, pts.slice(cut));
      expect([...f1, ...f2]).toEqual(wholeFull);
    }
  });
});

function bag<T extends object>(list: T[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of list) {
    const k = JSON.stringify(x);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}
