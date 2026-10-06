import { ValidationError } from './types';

/**
 * Streaming peak/valley extraction (ASTM E1049-85 §5.4.2).
 *
 * The raw time history is reduced to an alternating sequence of peaks and
 * valleys:
 *   - points that do not change direction are merged (the running max/min of a
 *     leg is tracked, so intermediate same-direction points disappear);
 *   - flat plateaus are de-duplicated (equal samples are ignored, also across
 *     block boundaries);
 *   - swings whose *amplitude* is below `hysteresis` are removed *before*
 *     counting. The threshold is in amplitude units: a swing is kept when its
 *     peak-to-valley range is >= 2 * hysteresis. hysteresis = 0 keeps every
 *     reversal.
 *
 * The reducer is an online dead-band (Schmitt) state machine. Every extremum it
 * emits is CONFIRMED and can never be revoked by later samples, which keeps the
 * persisted state tiny and guarantees that feeding the signal in ANY chunking
 * (point-by-point, random cuts, one block) produces an identical sequence — it
 * is a left fold over the samples.
 *
 *   empty        : no sample yet.
 *   undetermined : looking for the first leg whose range clears the band. Both
 *                  the running high and running low are tracked so a reversal
 *                  inside the band simply moves the starting extreme. When a
 *                  sample clears the band from one bound, that bound is emitted
 *                  as the first extremum and direction is fixed.
 *   up           : last emission was a valley (anchor); candidate is the
 *                  running maximum. A higher high extends the leg; a drop of
 *                  >= rangeMin confirms the candidate as a peak and flips to
 *                  down; smaller pullbacks stay inside the band.
 *   down         : mirror image.
 *
 * After a leg has cleared the band, anchor->candidate already spans >=
 * rangeMin, so any sample breaking beyond the anchor satisfies the reversal
 * test first; an emitted extremum is therefore never revoked.
 *
 * `flush()` emits the single still-open extremum reserved for the very end of
 * the whole history. Before finalization it is held back, so open swings do not
 * contribute to reported cycles.
 */

export interface PeakValleyState {
  mode: 'empty' | 'undetermined' | 'up' | 'down';
  /** Running bounds while in `undetermined`. */
  high: number | null;
  low: number | null;
  /** Most recent sample (plateau detection). */
  last: number | null;
  /** Running high in `up` / running low in `down`. */
  candidate: number | null;
  /** Emitted valley in `up` / emitted peak in `down`. */
  anchor: number | null;
}

export function initialPeakValleyState(): PeakValleyState {
  return { mode: 'empty', high: null, low: null, last: null, candidate: null, anchor: null };
}

export class PeakValleyExtractor {
  private state: PeakValleyState;
  private readonly rangeMin: number;

  constructor(private readonly hysteresisAmplitude: number, state?: PeakValleyState) {
    if (!Number.isFinite(hysteresisAmplitude) || hysteresisAmplitude < 0) {
      throw new ValidationError('hysteresis must be a finite non-negative number');
    }
    this.rangeMin = 2 * hysteresisAmplitude;
    this.state = state ? { ...state } : initialPeakValleyState();
  }

  getState(): PeakValleyState {
    return { ...this.state };
  }

  /** Feed one sample; returns 0 or 1 newly confirmed extremum. */
  push(x: number): number[] {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new ValidationError('sample must be a finite number');
    }
    const s = this.state;

    if (s.mode === 'empty') {
      s.mode = 'undetermined';
      s.high = x;
      s.low = x;
      s.last = x;
      return [];
    }

    if (x === s.last) return []; // plateau, including across blocks
    s.last = x;

    if (s.mode === 'undetermined') return this.pushUndetermined(x);
    return this.rangeMin === 0 ? this.pushNoBand(x) : this.pushWithBand(x);
  }

  private pushUndetermined(x: number): number[] {
    const s = this.state;
    const high = s.high as number;
    const low = s.low as number;
    const r = this.rangeMin;

    if (x - low >= r) {
      // Clearing rising leg starting at the running low.
      s.mode = 'up';
      s.anchor = low;
      s.candidate = x;
      s.high = null;
      s.low = null;
      return [low];
    }
    if (high - x >= r) {
      // Clearing falling leg starting at the running high.
      s.mode = 'down';
      s.anchor = high;
      s.candidate = x;
      s.high = null;
      s.low = null;
      return [high];
    }

    // Still inside the band: widen bounds and wait.
    if (x > high) s.high = x;
    if (x < low) s.low = x;
    return [];
  }

  private pushNoBand(x: number): number[] {
    const s = this.state;
    if (s.mode === 'up') {
      const peak = s.candidate as number;
      if (x >= peak) {
        s.candidate = x;
        return [];
      }
      s.mode = 'down';
      s.anchor = peak;
      s.candidate = x;
      return [peak];
    }
    // down
    const valley = s.candidate as number;
    if (x <= valley) {
      s.candidate = x;
      return [];
    }
    s.mode = 'up';
    s.anchor = valley;
    s.candidate = x;
    return [valley];
  }

  private pushWithBand(x: number): number[] {
    const s = this.state;
    const r = this.rangeMin;

    if (s.mode === 'up') {
      const peak = s.candidate as number;
      if (x >= peak) {
        s.candidate = x;
        return [];
      }
      if (peak - x >= r) {
        s.mode = 'down';
        s.anchor = peak;
        s.candidate = x;
        return [peak];
      }
      return []; // pullback inside the dead-band
    }

    // down
    const valley = s.candidate as number;
    if (x <= valley) {
      s.candidate = x;
      return [];
    }
    if (x - valley >= r) {
      s.mode = 'up';
      s.anchor = valley;
      s.candidate = x;
      return [valley];
    }
    return [];
  }

  /**
   * Emit the single extremum still held open at the end of the complete
   * history. Call exactly once, at finalization.
   *
   * No threshold: a constant/flat history emits its single value. With a
   * positive threshold, a history that never clears the band emits nothing
   * (no cycle-relevant swing).
   */
  flush(): number[] {
    const s = this.state;
    if (s.mode === 'empty') return [];
    if (s.mode === 'undetermined') {
      const value = s.high; // high === low for a constant history
      this.reset();
      if (this.rangeMin === 0 && value !== null) return [value];
      return [];
    }
    const out = s.candidate as number;
    this.reset();
    return [out];
  }

  private reset(): void {
    this.state = initialPeakValleyState();
  }
}

/** Reduce a whole block through an existing extractor; returns new extrema. */
export function pushBlock(extractor: PeakValleyExtractor, values: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const emitted = extractor.push(values[i] as number);
    for (const e of emitted) out.push(e);
  }
  return out;
}
