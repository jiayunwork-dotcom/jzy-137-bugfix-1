import { FastifyInstance } from 'fastify';
import {
  ConfigError,
  ConflictError,
  JobConfig,
  JobResult,
  NotFoundError,
  ValidationError,
} from '../core/types';
import { JobService } from '../service/jobService';

interface CreateJobBody {
  C?: number;
  m?: number;
  ultimateTensileStrength?: number;
  correction?: 'none' | 'goodman';
  hysteresis?: number;
}

interface AppendBody {
  sequence?: number;
  values?: unknown;
}

/**
 * JSON cannot represent Infinity (JSON.stringify would emit null, silently
 * hiding a static-failure result). Damage values are finite or +Infinity by
 * construction, so any non-finite damage is encoded as the string "Infinity";
 * clients can restore it with Number("Infinity") / float("Infinity").
 */
function encodeDamage(d: number): number | 'Infinity' {
  return Number.isFinite(d) ? d : 'Infinity';
}

/** Wire form of a JobResult: damages encoded as number | "Infinity". */
function encodeResult(result: JobResult): Omit<JobResult, 'cycles' | 'totalDamage'> & {
  cycles: Array<Omit<JobResult['cycles'][number], 'damage'> & { damage: number | 'Infinity' }>;
  totalDamage: number | 'Infinity';
} {
  return {
    ...result,
    cycles: result.cycles.map((c) => ({ ...c, damage: encodeDamage(c.damage) })),
    totalDamage: encodeDamage(result.totalDamage),
  };
}

export function registerRoutes(app: FastifyInstance, service: JobService): void {
  app.get('/health', async () => ({ ok: true }));

  app.post('/jobs', async (req, reply) => {
    const body = (req.body ?? {}) as CreateJobBody;
    const config: JobConfig = {
      C: body.C as number,
      m: body.m as number,
      ultimateTensileStrength: body.ultimateTensileStrength,
      correction: body.correction ?? 'none',
      hysteresis: body.hysteresis ?? 0,
    };
    const id = service.createJob(config);
    return reply.code(201).send({ jobId: id });
  });

  app.post('/jobs/:id/blocks', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as AppendBody;
    const result = service.appendBlock(id, body.sequence as number, body.values);
    return reply.code(200).send(encodeResult(result));
  });

  app.get('/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    return encodeResult(service.getResult(id));
  });

  app.post('/jobs/:id/finalize', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = service.finalize(id);
    return reply.code(200).send(encodeResult(result));
  });

  // Central error mapping.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ValidationError || err instanceof ConfigError) {
      return reply.code(400).send({ error: err.message });
    }
    // Malformed JSON body (e.g. a bare NaN token) fails Fastify's parser.
    const status = (err as { statusCode?: number }).statusCode;
    const code = (err as { code?: string }).code;
    if (status === 400 || code === 'FST_ERR_CTR_INVALID_BODY' || code === 'FST_ERR__INVALID_BODY') {
      return reply.code(400).send({ error: `invalid request body: ${err.message}` });
    }
    if (err instanceof NotFoundError) {
      return reply.code(404).send({ error: err.message });
    }
    if (err instanceof ConflictError) {
      return reply.code(409).send({ error: err.message });
    }
    _req.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  });
}
