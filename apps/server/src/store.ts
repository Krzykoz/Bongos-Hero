import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

import type { SongMeta } from '@bongos-hero/shared';

import { DATA_ROOT, audioPath, chartPath, metaPath, songDir } from './paths.js';

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function songIsComplete(id: string): Promise<boolean> {
  const [hasAudio, hasMeta, hasChart] = await Promise.all([
    pathExists(audioPath(id)),
    pathExists(metaPath(id)),
    pathExists(chartPath(id)),
  ]);
  return hasAudio && hasMeta && hasChart;
}

async function readMeta(id: string): Promise<SongMeta | null> {
  try {
    const raw = await readFile(metaPath(id), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.id !== 'string' ||
      typeof obj.title !== 'string' ||
      typeof obj.sourceUrl !== 'string' ||
      typeof obj.durationMs !== 'number' ||
      typeof obj.createdAt !== 'string'
    ) {
      return null;
    }
    const meta: SongMeta = {
      id: obj.id,
      title: obj.title,
      sourceUrl: obj.sourceUrl,
      durationMs: obj.durationMs,
      createdAt: obj.createdAt,
    };
    if (typeof obj.artist === 'string' && obj.artist.length > 0) {
      meta.artist = obj.artist;
    }
    return meta;
  } catch {
    return null;
  }
}

export async function listSongs(): Promise<SongMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(DATA_ROOT);
  } catch {
    return [];
  }

  const candidates = await Promise.all(
    entries.map(async (name) => {
      const dir = songDir(name);
      try {
        const s = await stat(dir);
        if (!s.isDirectory()) return null;
      } catch {
        return null;
      }
      if (!(await songIsComplete(name))) return null;
      const meta = await readMeta(name);
      if (!meta) return null;
      return meta;
    }),
  );

  const songs: SongMeta[] = candidates.filter((m): m is SongMeta => m !== null);
  songs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return songs;
}

export async function getSong(id: string): Promise<SongMeta> {
  const meta = await readMeta(id);
  if (!meta) {
    throw new Error(`Song not found: ${id}`);
  }
  return meta;
}

export async function deleteSong(id: string): Promise<void> {
  await rm(songDir(id), { recursive: true, force: true });
}

export async function writeMeta(id: string, meta: SongMeta): Promise<void> {
  await mkdir(songDir(id), { recursive: true });
  await writeFile(metaPath(id), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}
