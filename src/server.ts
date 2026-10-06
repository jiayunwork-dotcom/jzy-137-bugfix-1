import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApp } from './http/app';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? '/data/rainflow.db';

async function main(): Promise<void> {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const { app, store } = buildApp({ dbPath: DB_PATH, logger: true });

  const shutdown = async (): Promise<void> => {
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.listen({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
