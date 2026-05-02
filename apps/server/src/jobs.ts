import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import type { JobState, JobStatus, SongMeta } from '@bongos-hero/shared';

import { extractOnsetFeatures } from './audioFeatures.js';
import { buildChart } from './chart.js';
import { detectOnsets } from './onsets.js';
import { audioPath, chartPath, songDir } from './paths.js';
import { writeMeta } from './store.js';
import { transcodeToOgg } from './transcode.js';
import { downloadAudio } from './ytdlp.js';

export interface JobsManagerOptions {
  /** Max concurrent import jobs. Default 1 (yt-dlp + ffmpeg are CPU-heavy). */
  concurrency?: number;
}

type Subscriber = (state: JobState) => void;

const TERMINAL_RETENTION_MS = 60 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function isTerminal(status: JobStatus): boolean {
  return status === 'done' || status === 'error';
}

export class JobsManager {
  private readonly concurrency: number;
  private readonly jobs = new Map<string, JobState>();
  private readonly queue: string[] = [];
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private running = 0;

  constructor(opts?: JobsManagerOptions) {
    this.concurrency = Math.max(1, Math.floor(opts?.concurrency ?? 1));
  }

  enqueueImport(url: string): string {
    const id = randomUUID();
    const ts = nowIso();
    const state: JobState = {
      id,
      status: 'queued',
      progress: 0,
      sourceUrl: url,
      createdAt: ts,
      updatedAt: ts,
    };
    this.jobs.set(id, state);
    this.queue.push(id);
    queueMicrotask(() => this.pump());
    return id;
  }

  get(id: string): JobState | undefined {
    this.gc();
    const state = this.jobs.get(id);
    if (!state) return undefined;
    return { ...state };
  }

  list(): JobState[] {
    this.gc();
    return Array.from(this.jobs.values()).map((s) => ({ ...s }));
  }

  subscribe(jobId: string, cb: Subscriber): () => void {
    let set = this.subscribers.get(jobId);
    if (!set) {
      set = new Set();
      this.subscribers.set(jobId, set);
    }
    set.add(cb);
    return () => {
      const s = this.subscribers.get(jobId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.subscribers.delete(jobId);
    };
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, state] of this.jobs) {
      if (!isTerminal(state.status)) continue;
      const updated = Date.parse(state.updatedAt);
      if (Number.isFinite(updated) && now - updated > TERMINAL_RETENTION_MS) {
        this.jobs.delete(id);
        this.subscribers.delete(id);
      }
    }
  }

  private updateJob(id: string, partial: Partial<Omit<JobState, 'id' | 'createdAt'>>): void {
    const current = this.jobs.get(id);
    if (!current) return;
    const next: JobState = {
      ...current,
      ...partial,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: nowIso(),
    };
    this.jobs.set(id, next);
    const subs = this.subscribers.get(id);
    if (subs && subs.size > 0) {
      const snapshot: JobState = { ...next };
      for (const cb of subs) {
        try {
          cb(snapshot);
        } catch {
          // Swallow subscriber errors to keep the worker resilient.
        }
      }
    }
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) break;
      const state = this.jobs.get(id);
      if (!state) continue;
      this.running++;
      void this.runJob(id, state.sourceUrl).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async runJob(jobId: string, url: string): Promise<void> {
    const songId = randomUUID();
    const dir = songDir(songId);
    let dlTitle = 'Unknown title';
    let dlArtist: string | undefined;
    let dlSourceUrl = url;
    let rawAudioPath: string | null = null;

    try {
      await mkdir(dir, { recursive: true });

      // Step 1: download
      this.updateJob(jobId, { status: 'downloading', progress: 0 });
      const dl = await downloadAudio({
        url,
        destDir: dir,
        onProgress: (p) => {
          const clamped = Math.max(0, Math.min(1, p));
          this.updateJob(jobId, { progress: clamped });
        },
      });
      rawAudioPath = dl.rawAudioPath;
      dlTitle = dl.title;
      dlArtist = dl.artist;
      dlSourceUrl = dl.sourceUrl;

      // Step 2: transcode
      this.updateJob(jobId, { status: 'transcoding', progress: 0 });
      const out = audioPath(songId);
      const { durationMs } = await transcodeToOgg({
        inputPath: dl.rawAudioPath,
        outputPath: out,
      });
      this.updateJob(jobId, { progress: 1 });

      // Best-effort cleanup of raw download
      try {
        await rm(dl.rawAudioPath, { force: true });
      } catch {
        // ignore
      }
      rawAudioPath = null;

      // Step 3: chart
      this.updateJob(jobId, { status: 'charting', progress: 0 });
      const onsets = await detectOnsets({ audioPath: out });
      this.updateJob(jobId, { progress: 0.4 });
      const features = await extractOnsetFeatures({
        audioPath: out,
        onsetsSec: onsets.timesSec,
      });
      this.updateJob(jobId, { progress: 0.8 });
      const chart = buildChart({ features });
      await writeFile(chartPath(songId), `${JSON.stringify(chart, null, 2)}\n`, 'utf8');
      this.updateJob(jobId, { progress: 1 });

      // Write meta
      const meta: SongMeta = {
        id: songId,
        title: dlTitle,
        sourceUrl: dlSourceUrl,
        durationMs,
        createdAt: nowIso(),
      };
      if (dlArtist !== undefined) meta.artist = dlArtist;
      await writeMeta(songId, meta);

      this.updateJob(jobId, { status: 'done', progress: 1, songId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateJob(jobId, {
        status: 'error',
        error: message.slice(-2000),
      });
      // Best-effort cleanup of partial song dir
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      if (rawAudioPath) {
        try {
          await rm(rawAudioPath, { force: true });
        } catch {
          // ignore
        }
      }
    }
  }
}
