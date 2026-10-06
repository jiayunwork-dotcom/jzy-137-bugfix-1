/**
 * Rainflow counting kernel, ASTM E1049-85 §5.4.4 (the "three point" /
 * Downing-Socie stack algorithm), presented as an online reducer.
 *
 * Turning points are pushed one at a time onto a stack. After each push, while
 * the stack holds at least four points, label the last four
 *
 *     ..., S(n-3), S(n-2), S(n-1), S(n)
 *
 * and form the three ranges (ASTM §5.4.4.2):
 *
 *     X = |S(n-2) - S(n-3)|
 *     Y = |S(n-1) - S(n-2)|
 *     Z = |S(n)   - S(n-1)|
 *
 * If X >= Y and Y <= Z, the inner pair S(n-2),S(n-1) forms one FULL cycle of
 * range Y; those two points are discarded and the test is repeated on the new
 * stack top. Otherwise the next turning point is read.
 *
 * Online equivalence: after appending one point the only newly-testable windows
 * are those ending at that point; once a window fails the test it cannot become
 * removable unless a new point is added (which changes Z and re-runs the test at
 * the top). So checking just the stack top after every push reproduces the
 * standard's repeated whole-residue scans bit-for-bit, regardless of how the
 * input is chunked.
 *
 * `residualHalfCycles()` (finalization only) converts the remaining stack into
 * residue half cycles per §5.4.4.3: the residual contains no extractable full
 * cycle, and each successive pair of residual points contributes HALF a cycle,
 * in the residual's natural order (matching the X1.1 example table).
 */

export interface RawCycle {
  /** Full stress range = |peak - valley|. */
  range: number;
  mean: number;
  count: number;
  kind: 'full' | 'half';
}

export class RainflowAccumulator {
  private stack: number[];

  constructor(stack?: number[]) {
    this.stack = stack ? [...stack] : [];
  }

  getStack(): number[] {
    return [...this.stack];
  }

  /** Push one confirmed turning point; returns newly completed full cycles. */
  push(point: number): RawCycle[] {
    const out: RawCycle[] = [];
    const top = this.stack[this.stack.length - 1];
    if (top === undefined || point !== top) {
      this.stack.push(point); // ignore a duplicated neighbour (plateau guard)
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const cycle = this.tryExtract();
      if (!cycle) break;
      out.push(cycle);
    }
    return out;
  }

  private tryExtract(): RawCycle | null {
    const n = this.stack.length;
    if (n < 4) return null;
    const s3 = this.stack[n - 4] as number; // S(n-3)
    const s2 = this.stack[n - 3] as number; // S(n-2)
    const s1 = this.stack[n - 2] as number; // S(n-1)
    const s0 = this.stack[n - 1] as number; // S(n)
    const x = Math.abs(s2 - s3);
    const y = Math.abs(s1 - s2);
    const z = Math.abs(s0 - s1);
    if (x >= y && y <= z) {
      const mean = (s2 + s1) / 2;
      this.stack.splice(n - 3, 2); // remove S(n-2), S(n-1)
      return { range: y, mean, count: 1, kind: 'full' };
    }
    return null;
  }

  /**
   * Residue at finalization (ASTM §5.4.4.3 / example X5.4). The remaining
   * stack holds no extractable full cycle; the range between each pair of
   * successive residual points is counted as HALF a cycle, emitted in the
   * natural order of the residual (point 0->1, 1->2, ...). This is exactly the
   * row order of the half cycles in the standard's X1.1 example table.
   */
  residualHalfCycles(): RawCycle[] {
    const half: RawCycle[] = [];
    for (let i = 0; i + 1 < this.stack.length; i++) {
      const a = this.stack[i] as number;
      const b = this.stack[i + 1] as number;
      half.push({ range: Math.abs(b - a), mean: (a + b) / 2, count: 0.5, kind: 'half' });
    }
    return half;
  }
}

/** Push a block of turning points; returns completed full cycles in order. */
export function pushTurningPoints(acc: RainflowAccumulator, points: ArrayLike<number>): RawCycle[] {
  const out: RawCycle[] = [];
  for (let i = 0; i < points.length; i++) {
    for (const c of acc.push(points[i] as number)) out.push(c);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Offline reference implementation (used by the test-suite only).     */
/* ------------------------------------------------------------------ */

/**
 * Offline ASTM E1049 over a complete turning-point sequence. Repeatedly scans
 * the residue and removes an inner full cycle whenever the range test holds,
 * then converts the remainder to half cycles. Returns the same multiset of
 * cycles as the online accumulator.
 */
export function offlineRainflow(points: ArrayLike<number>): RawCycle[] {
  const work: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const v = points[i] as number;
    if (work[work.length - 1] !== v) work.push(v);
  }

  const full: RawCycle[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i + 3 < work.length; i++) {
      const s0 = work[i] as number;
      const s1 = work[i + 1] as number;
      const s2 = work[i + 2] as number;
      const s3 = work[i + 3] as number;
      const x = Math.abs(s1 - s0);
      const y = Math.abs(s2 - s1);
      const z = Math.abs(s3 - s2);
      if (x >= y && y <= z) {
        full.push({ range: y, mean: (s1 + s2) / 2, count: 1, kind: 'full' });
        work.splice(i + 1, 2);
        changed = true;
        break;
      }
    }
  }

  const half: RawCycle[] = [];
  for (let i = 0; i + 1 < work.length; i++) {
    const a = work[i] as number;
    const b = work[i + 1] as number;
    half.push({ range: Math.abs(b - a), mean: (a + b) / 2, count: 0.5, kind: 'half' });
  }
  return [...full, ...half];
}
