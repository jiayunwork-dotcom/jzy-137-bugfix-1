import { FastifyInstance } from 'fastify';
import {
  ConfigError,
  ConflictError,
  JobConfig,
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
    return reply.code(200).send(result);
  });

  app.get('/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    return service.getResult(id);
  });

  app.post('/jobs/:id/finalize', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = service.finalize(id);
    return reply.code(200).send(result);
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
