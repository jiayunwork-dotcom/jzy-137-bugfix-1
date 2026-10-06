import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import {
  ConflictError,
  JobConfig,
  JobStatus,
  NotFoundError,
  ValidationError,
} from '../core/types';
import { PeakValleyState } from '../core/peakvalley';

const MAX_BLOCK_POINTS = 200_000;

export interface StoredCycle {
  id: number;
  seq: number;
  amplitude: number;
  mean: number;
  count: number;
  damage: number;
  kind: 'full' | 'half';
}

interface JobRow {
  id: string;
  config_json: string;
  status: JobStatus;
  pv_state_json: string;
  rf_stack_json: string;
  last_sequence: number | null;
  sample_count: number;
  total_damage: number;
  finalized_at: string | null;
}

interface BlockRow {
  job_id: string;
  sequence: number;
  checksum: string;
  point_count: number;
  created_at: string;
}

export interface AppendOutcome {
  /** Cycles newly made deterministic by this append. */
  cycles: StoredCycle[];
  totalDamage: number;
  sampleCount: number;
  lastSequence: number;
}

export class JobStore {
  private readonly db: DB;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','finalized')),
        pv_state_json TEXT NOT NULL,
        rf_stack_json TEXT NOT NULL,
        last_sequence INTEGER,
        sample_count INTEGER NOT NULL DEFAULT 0,
        total_damage REAL NOT NULL DEFAULT 0,
        finalized_at TEXT
      );

      CREATE TABLE IF NOT EXISTS blocks (
        job_id TEXT NOT NULL REFERENCES jobs(id),
        sequence INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        point_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (job_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        seq INTEGER NOT NULL,
        amplitude REAL NOT NULL,
        mean REAL NOT NULL,
        count REAL NOT NULL,
        damage REAL NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('full','half'))
      );
      CREATE INDEX IF NOT EXISTS idx_cycles_job ON cycles (job_id, seq);
    `);
  }

  createJob(config: JobConfig): string {
    const id = randomUUID();
    const pv: PeakValleyState = {
      mode: 'empty',
      high: null,
      low: null,
      last: null,
      candidate: null,
      anchor: null,
    };
    this.db
      .prepare(
        `INSERT INTO jobs (id, config_json, status, pv_state_json, rf_stack_json)
         VALUES (?, ?, 'open', ?, '[]')`,
      )
      .run(id, JSON.stringify(config), JSON.stringify(pv));
    return id;
  }

  private getRow(jobId: string): JobRow {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE id = ?`)
      .get(jobId) as JobRow | undefined;
    if (!row) throw new NotFoundError(`job ${jobId} not found`);
    return row;
  }

  getConfig(jobId: string): JobConfig {
    return JSON.parse(this.getRow(jobId).config_json) as JobConfig;
  }

  getStatus(jobId: string): JobStatus {
    return this.getRow(jobId).status;
  }

  getEngineState(jobId: string): {
    config: JobConfig;
    status: JobStatus;
    pv: PeakValleyState;
    stack: number[];
    lastSequence: number | null;
    sampleCount: number;
    totalDamage: number;
  } {
    const row = this.getRow(jobId);
    return {
      config: JSON.parse(row.config_json) as JobConfig,
      status: row.status,
      pv: JSON.parse(row.pv_state_json) as PeakValleyState,
      stack: JSON.parse(row.rf_stack_json) as number[],
      lastSequence: row.last_sequence,
      sampleCount: row.sample_count,
      totalDamage: row.total_damage,
    };
  }

  getBlockChecksum(jobId: string, sequence: number): BlockRow | undefined {
    return this.db
      .prepare(`SELECT * FROM blocks WHERE job_id = ? AND sequence = ?`)
      .get(jobId, sequence) as BlockRow | undefined;
  }

  /**
   * Validate a block's envelope. Throws on: finalized job, gap, duplicate of a
   * different payload, or invalid point count/payload.
   */
  validateBlock(
    jobId: string,
    status: JobStatus,
    lastSequence: number | null,
    sequence: number,
    values: unknown,
  ): { points: number[]; duplicate: boolean } {
    if (status === 'finalized') {
      throw new ConflictError('job is finalized; no further blocks are accepted');
    }
    if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence <= 0) {
      throw new ValidationError('sequence must be a positive integer');
    }
    const expected = (lastSequence ?? 0) + 1;
    const existing = this.getBlockChecksum(jobId, sequence);
    if (existing) {
      // Duplicate sequence: only legal as an exact idempotent re-submission,
      // which is verified by the caller against checksum of `values`.
      return { points: this.toPoints(values), duplicate: true };
    }
    if (sequence !== expected) {
      throw new ConflictError(
        `out-of-order block: expected sequence ${expected}, got ${sequence}`,
      );
    }
    return { points: this.toPoints(values), duplicate: false };
  }

  private toPoints(values: unknown): number[] {
    if (!Array.isArray(values)) {
      throw new ValidationError('values must be an array of numbers');
    }
    if (values.length === 0) {
      throw new ValidationError('block must contain at least one point');
    }
    if (values.length > MAX_BLOCK_POINTS) {
      throw new ValidationError(
        `block has ${values.length} points; limit is ${MAX_BLOCK_POINTS}`,
      );
    }
    const out: number[] = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      // NaN serialises to JSON null, so null must be rejected explicitly.
      if (typeof v !== 'number' || v === null || !Number.isFinite(v)) {
        throw new ValidationError(
          `values[${i}] is not a finite number (got ${v === null ? 'null' : String(v)})`,
        );
      }
      out[i] = v as number;
    }
    return out;
  }

  /**
   * Persist the deterministic result of one append inside a single
   * transaction: the block row, newly completed cycles, and all engine state.
   * Either everything commits or nothing does (crash/restart safe).
   */
  commitAppend(args: {
    jobId: string;
    sequence: number;
    checksum: string;
    pointCount: number;
    pv: PeakValleyState;
    stack: number[];
    newCycles: Array<Omit<StoredCycle, 'id' | 'seq'>>;
    totalDamage: number;
  }): StoredCycle[] {
    return this.db.transaction((): StoredCycle[] => {
      this.db
        .prepare(
          `INSERT INTO blocks (job_id, sequence, checksum, point_count)
           VALUES (?, ?, ?, ?)`,
        )
        .run(args.jobId, args.sequence, args.checksum, args.pointCount);

      const insertCycle = this.db.prepare(
        `INSERT INTO cycles (job_id, seq, amplitude, mean, count, damage, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      let seq = this.nextCycleSeq(args.jobId);
      const stored: StoredCycle[] = [];
      for (const c of args.newCycles) {
        const info = insertCycle.run(
          args.jobId,
          seq,
          c.amplitude,
          c.mean,
          c.count,
          c.damage,
          c.kind,
        );
        stored.push({ id: Number(info.lastInsertRowid), seq, ...c });
        seq++;
      }

      this.db
        .prepare(
          `UPDATE jobs SET pv_state_json = ?, rf_stack_json = ?,
             last_sequence = ?, sample_count = sample_count + ?,
             total_damage = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(args.pv),
          JSON.stringify(args.stack),
          args.sequence,
          args.pointCount,
          args.totalDamage,
          args.jobId,
        );
      return stored;
    })();
  }

  private nextCycleSeq(jobId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM cycles WHERE job_id = ?`)
      .get(jobId) as { m: number };
    return row.m + 1;
  }

  /** Record half cycles at finalization and flip status. Idempotent. */
  commitFinalize(
    jobId: string,
    pv: PeakValleyState,
    stack: number[],
    halfCycles: Array<Omit<StoredCycle, 'id' | 'seq'>>,
    totalDamage: number,
  ): StoredCycle[] {
    return this.db.transaction((): StoredCycle[] => {
      const row = this.getRow(jobId);
      if (row.status === 'finalized') {
        return this.listCycles(jobId);
      }
      const insertCycle = this.db.prepare(
        `INSERT INTO cycles (job_id, seq, amplitude, mean, count, damage, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      let seq = this.nextCycleSeq(jobId);
      const stored: StoredCycle[] = [];
      for (const c of halfCycles) {
        const info = insertCycle.run(jobId, seq, c.amplitude, c.mean, c.count, c.damage, c.kind);
        stored.push({ id: Number(info.lastInsertRowid), seq, ...c });
        seq++;
      }
      this.db
        .prepare(
          `UPDATE jobs SET status='finalized', finalized_at=datetime('now'),
             pv_state_json=?, rf_stack_json=?, total_damage=? WHERE id=?`,
        )
        .run(JSON.stringify(pv), JSON.stringify(stack), totalDamage, jobId);
      return this.listCycles(jobId);
    })();
  }

  listCycles(jobId: string): StoredCycle[] {
    return this.db
      .prepare(
        `SELECT id, amplitude, mean, count, damage, kind FROM cycles
         WHERE job_id = ? ORDER BY seq ASC, id ASC`,
      )
      .all(jobId) as StoredCycle[];
  }

  countBlocks(jobId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM blocks WHERE job_id = ?`)
      .get(jobId) as { c: number };
    return row.c;
  }
}
