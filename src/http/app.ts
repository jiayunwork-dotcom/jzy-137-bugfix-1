import Fastify, { FastifyInstance } from 'fastify';
import { JobStore } from '../store/sqliteStore';
import { JobService } from '../service/jobService';
import { registerRoutes } from './routes';

export interface AppDeps {
  dbPath: string;
  logger?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  store: JobStore;
  service: JobService;
}

export function buildApp(deps: AppDeps): BuiltApp {
  const app = Fastify({ logger: deps.logger ?? false });
  const store = new JobStore(deps.dbPath);
  const service = new JobService(store);
  registerRoutes(app, service);
  return { app, store, service };
}
