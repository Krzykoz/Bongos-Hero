import Fastify from 'fastify';
import cors from '@fastify/cors';

import { JobsManager } from './jobs.js';
import { checkPrereqs } from './prereqs.js';
import { registerRoutes } from './routes.js';

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

try {
  const versions = await checkPrereqs();
  app.log.info({ versions }, 'external tools verified');
} catch (err) {
  app.log.error({ err }, 'missing prerequisites — server will start but /api/import will fail');
}

const jobs = new JobsManager({ concurrency: 1 });
await registerRoutes(app, jobs);

const port = Number(process.env.PORT ?? 5174);
const host = process.env.HOST ?? '127.0.0.1';

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
