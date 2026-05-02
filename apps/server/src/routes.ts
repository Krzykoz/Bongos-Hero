import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ChartV1, ImportResponse, JobState, SongMeta } from '@bongos-hero/shared';

import type { JobsManager } from './jobs.js';
import { audioPath, chartPath } from './paths.js';
import { deleteSong, getSong, listSongs } from './store.js';

const URL_RE = /^https?:\/\/\S+$/i;

interface IdParams {
  id: string;
}

interface ImportBody {
  url?: unknown;
}

interface ParsedRange {
  start: number;
  end: number;
}

function parseRangeHeader(header: string, size: number): ParsedRange | 'invalid' | null {
  if (size <= 0) return 'invalid';
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  const startStr = m[1] ?? '';
  const endStr = m[2] ?? '';
  if (startStr === '' && endStr === '') return 'invalid';

  let start: number;
  let end: number;
  if (startStr === '') {
    // Suffix range: last N bytes
    const suffix = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    if (!Number.isFinite(start) || start < 0) return 'invalid';
    if (endStr === '') {
      end = size - 1;
    } else {
      end = Number.parseInt(endStr, 10);
      if (!Number.isFinite(end) || end < 0) return 'invalid';
    }
  }

  if (start >= size) return 'invalid';
  if (end >= size) end = size - 1;
  if (end < start) return 'invalid';

  return { start, end };
}

async function fileSize(p: string): Promise<number | null> {
  try {
    const s = await stat(p);
    if (!s.isFile()) return null;
    return s.size;
  } catch {
    return null;
  }
}

export async function registerRoutes(app: FastifyInstance, jobs: JobsManager): Promise<void> {
  app.get('/api/health', async () => ({ ok: true, service: 'bongos-hero-server' }));

  app.get('/api/songs', async (): Promise<SongMeta[]> => {
    return listSongs();
  });

  app.post('/api/import', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as ImportBody;
    const url = body.url;
    if (typeof url !== 'string' || url.trim().length === 0 || !URL_RE.test(url.trim())) {
      return reply.code(400).send({ error: 'Invalid url; expected http(s) URL string.' });
    }
    const jobId = jobs.enqueueImport(url.trim());
    const payload: ImportResponse = { jobId };
    return reply.code(202).send(payload);
  });

  app.get('/api/jobs', async (): Promise<JobState[]> => {
    return jobs.list();
  });

  app.get('/api/jobs/:id', async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    const state = jobs.get(req.params.id);
    if (!state) return reply.code(404).send({ error: 'Unknown job id' });
    return state;
  });

  app.get('/api/songs/:id', async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    try {
      const meta = await getSong(req.params.id);
      return meta;
    } catch {
      return reply.code(404).send({ error: 'Song not found' });
    }
  });

  app.get('/api/songs/:id/chart', async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    const file = chartPath(req.params.id);
    const size = await fileSize(file);
    if (size === null) {
      return reply.code(404).send({ error: 'Chart not found' });
    }
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as ChartV1;
      return parsed;
    } catch {
      return reply.code(500).send({ error: 'Failed to read chart' });
    }
  });

  app.get('/api/songs/:id/audio', async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    const file = audioPath(req.params.id);
    const size = await fileSize(file);
    if (size === null) {
      return reply.code(404).send({ error: 'Audio not found' });
    }

    const rangeHeader = req.headers.range;
    if (typeof rangeHeader === 'string' && rangeHeader.length > 0) {
      const parsed = parseRangeHeader(rangeHeader, size);
      if (parsed === 'invalid') {
        reply
          .code(416)
          .header('Content-Range', `bytes */${size}`)
          .header('Accept-Ranges', 'bytes');
        return reply.send({ error: 'Invalid Range header' });
      }
      if (parsed) {
        const { start, end } = parsed;
        const chunkSize = end - start + 1;
        reply
          .code(206)
          .header('Content-Type', 'audio/ogg')
          .header('Accept-Ranges', 'bytes')
          .header('Content-Range', `bytes ${start}-${end}/${size}`)
          .header('Content-Length', String(chunkSize));
        return reply.send(createReadStream(file, { start, end }));
      }
    }

    reply
      .code(200)
      .header('Content-Type', 'audio/ogg')
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', String(size));
    return reply.send(createReadStream(file));
  });

  app.delete('/api/songs/:id', async (req: FastifyRequest<{ Params: IdParams }>) => {
    await deleteSong(req.params.id);
    return { ok: true };
  });
}
