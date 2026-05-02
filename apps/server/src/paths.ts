import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// <repo>/apps/server/src/paths.ts -> ../../../data/songs
export const DATA_ROOT: string = path.resolve(here, '..', '..', '..', 'data', 'songs');

mkdirSync(DATA_ROOT, { recursive: true });

export function songDir(id: string): string {
  return path.join(DATA_ROOT, id);
}

export function audioPath(id: string): string {
  return path.join(songDir(id), 'audio.ogg');
}

export function metaPath(id: string): string {
  return path.join(songDir(id), 'meta.json');
}

export function chartPath(id: string): string {
  return path.join(songDir(id), 'chart.json');
}
