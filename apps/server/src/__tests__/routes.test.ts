/**
 * Route-level tests for `POST /api/rechart`.
 *
 * Mocks `detectOnsets` + `extractOnsetFeatures` so we don't shell out to
 * `aubioonset` / `ffmpeg` — they return canned PCM-derived feature data
 * dense enough that the chart pipeline produces a non-trivial chart and the
 * tunable knobs (rmsFloor, minSpacingMs, centroidThreshold) cause measurable
 * deltas in the output.
 *
 * Each test creates a fresh temp song directory under `data/songs/` with a
 * stub `audio.ogg`, registers the routes against an isolated Fastify
 * instance, and asserts both the response body and the on-disk side effect
 * (chart.json written for committed runs, untouched for `preview: true`).
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OnsetFeature } from '../audioFeatures.js';
import { audioPath, chartPath, songDir } from '../paths.js';

// ---- Module mocks -----------------------------------------------------------
// Hoisted by Vitest. The mock factories are evaluated before any other
// module-level imports in this file resolve, so the route handler's
// `import { detectOnsets } from './onsets.js'` picks up the mock.

vi.mock('../onsets.js', () => ({
  detectOnsets: vi.fn(),
}));

vi.mock('../audioFeatures.js', () => ({
  extractOnsetFeatures: vi.fn(),
}));

// Imports of the mocked modules MUST come AFTER the vi.mock calls above.
const { detectOnsets } = await import('../onsets.js');
const { extractOnsetFeatures } = await import('../audioFeatures.js');
const { registerRoutes } = await import('../routes.js');

const mockedDetectOnsets = vi.mocked(detectOnsets);
const mockedExtractFeatures = vi.mocked(extractOnsetFeatures);

// ---- Fixture builders -------------------------------------------------------

function makeFeature(
  tSec: number,
  rms: number,
  stereoBalance: number,
  spectralCentroidHz: number,
): OnsetFeature {
  return { tSec, rms, stereoBalance, spectralCentroidHz };
}

/**
 * 30 onsets, 200 ms apart. Half above and half below `rmsFloor=0.005` so
 * raising the floor shrinks the kept set; alternating L/R stereo balance
 * dodges the same-lane spacing filter; a centroid that flips around 2000 Hz
 * exercises the centroid threshold knob for the stereo-neutral subset.
 */
function buildFixture(): OnsetFeature[] {
  const features: OnsetFeature[] = [];
  for (let i = 0; i < 30; i++) {
    const tSec = 0.1 + i * 0.2;
    // RMS oscillates: even indexes high (0.05), odd indexes low (0.002).
    const rms = i % 2 === 0 ? 0.05 : 0.002;
    const stereoBalance = i % 2 === 0 ? -0.7 : 0.7;
    const spectralCentroidHz = i % 3 === 0 ? 800 : 2400;
    features.push(makeFeature(tSec, rms, stereoBalance, spectralCentroidHz));
  }
  return features;
}

// Track temp song ids per test so we can clean them up.
const createdSongIds: string[] = [];

async function setupSong(): Promise<string> {
  const id = `__rechart_test_${randomUUID()}`;
  createdSongIds.push(id);
  const dir = songDir(id);
  await mkdir(dir, { recursive: true });
  // Stub audio file — the route only checks that fileSize() > 0; the mocked
  // detectOnsets/extractOnsetFeatures never actually decode it.
  await writeFile(audioPath(id), 'stub-audio-bytes', 'utf8');
  return id;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Tests don't enqueue jobs; a stub satisfies the registerRoutes signature.
  const stubJobs = {
    enqueueImport: () => 'stub-job-id',
    list: () => [],
    get: () => undefined,
  } as unknown as Parameters<typeof registerRoutes>[1];
  await registerRoutes(app, stubJobs);
  await app.ready();
  return app;
}

// ---- Lifecycle --------------------------------------------------------------

beforeEach(() => {
  // Default mock impls: deterministic 30-onset feature set.
  const features = buildFixture();
  mockedDetectOnsets.mockResolvedValue({
    timesSec: features.map((f) => f.tSec),
  });
  mockedExtractFeatures.mockResolvedValue({
    sampleRate: 22050,
    durationSec: features[features.length - 1]!.tSec + 0.5,
    channelCount: 2,
    features,
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  // Cleanup temp song dirs.
  for (const id of createdSongIds) {
    await rm(songDir(id), { recursive: true, force: true });
  }
  createdSongIds.length = 0;
});

// ---- Tests ------------------------------------------------------------------

describe('POST /api/rechart', () => {
  it('returns the built chart and writes chart.json when preview is omitted (default commit)', async () => {
    const songId = await setupSong();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rechart',
        payload: { songId },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ chart: { version: number; notes: unknown[] } }>();
      expect(body.chart.version).toBe(1);
      expect(Array.isArray(body.chart.notes)).toBe(true);
      expect(body.chart.notes.length).toBeGreaterThan(0);

      // chart.json must have been persisted.
      expect(existsSync(chartPath(songId))).toBe(true);
      const persisted = JSON.parse(await readFile(chartPath(songId), 'utf8')) as {
        notes: unknown[];
      };
      expect(persisted.notes.length).toBe(body.chart.notes.length);
    } finally {
      await app.close();
    }
  });

  it('returns the built chart and does NOT write chart.json when preview=true', async () => {
    const songId = await setupSong();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rechart',
        payload: { songId, preview: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ chart: { version: number; notes: unknown[] } }>();
      expect(body.chart.version).toBe(1);
      expect(body.chart.notes.length).toBeGreaterThan(0);

      // The persisted chart.json must NOT exist (we never wrote it for this song).
      expect(existsSync(chartPath(songId))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('preview=true does NOT clobber a pre-existing chart.json on disk', async () => {
    const songId = await setupSong();
    const sentinel = `${JSON.stringify({ version: 1, audioOffsetMs: 0, notes: [], _sentinel: true }, null, 2)}\n`;
    await writeFile(chartPath(songId), sentinel, 'utf8');

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rechart',
        payload: { songId, preview: true, rmsFloor: 0.04 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ chart: { notes: unknown[] } }>();
      // The response carries a freshly built chart...
      expect(body.chart.notes.length).toBeGreaterThanOrEqual(0);
      // ...but the file on disk is byte-identical to the sentinel we wrote.
      const onDisk = await readFile(chartPath(songId), 'utf8');
      expect(onDisk).toBe(sentinel);
    } finally {
      await app.close();
    }
  });

  it('tunable overrides flow through to the builder in committed (non-preview) mode', async () => {
    const songId = await setupSong();
    const app = await buildApp();
    try {
      // Baseline: default tunables (rmsFloor=0.005) → all 15 high-RMS onsets kept.
      const baseline = await app.inject({
        method: 'POST',
        url: '/api/rechart',
        payload: { songId },
      });
      expect(baseline.statusCode).toBe(200);
      const baselineNotes = baseline.json<{ chart: { notes: unknown[] } }>().chart.notes.length;

      // Tuned: rmsFloor raised above the high-onset RMS (0.05) → 0 notes survive.
      const tuned = await app.inject({
        method: 'POST',
        url: '/api/rechart',
        payload: { songId, rmsFloor: 0.1 },
      });
      expect(tuned.statusCode).toBe(200);
      const tunedNotes = tuned.json<{ chart: { notes: unknown[] } }>().chart.notes.length;

      // The override must take effect — far fewer notes survive the floor.
      expect(tunedNotes).toBeLessThan(baselineNotes);
      expect(tunedNotes).toBe(0);

      // The persisted chart matches the tuned (most-recent) result.
      const persisted = JSON.parse(await readFile(chartPath(songId), 'utf8')) as {
        notes: unknown[];
      };
      expect(persisted.notes.length).toBe(tunedNotes);
    } finally {
      await app.close();
    }
  });

  it('tunable overrides flow through to the builder in preview mode', async () => {
    const songId = await setupSong();
    const app = await buildApp();
    try {
      const baseline = await app.inject({
        method: 'POST',
        url: '/api/rechart',
        payload: { songId, preview: true },
      });
      expect(baseline.statusCode).toBe(200);
      const baselineNotes = baseline.json<{ chart: { notes: unknown[] } }>().chart.notes.length;

      const tuned = await app.inject({
        method: 'POST',
        url: '/api/rechart',
        payload: { songId, preview: true, minSpacingMs: 1000 },
      });
      expect(tuned.statusCode).toBe(200);
      const tunedNotes = tuned.json<{ chart: { notes: unknown[] } }>().chart.notes.length;

      // 1000 ms min spacing on a 30-onset, 6-second fixture → many fewer notes.
      expect(tunedNotes).toBeLessThan(baselineNotes);
      // Neither preview run wrote chart.json.
      expect(existsSync(chartPath(songId))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('rejects requests without a string songId with 400', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rechart',
        payload: { preview: true },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the song has no audio.ogg on disk', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rechart',
        payload: { songId: '__rechart_test_does_not_exist', preview: true },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
