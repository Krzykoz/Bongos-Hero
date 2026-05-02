import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type { SongMeta } from '@bongos-hero/shared';

import { audioPath, chartPath, songDir } from '../paths.js';
import { deleteSong, listSongs, songIsComplete, writeMeta } from '../store.js';

export async function runStoreSmoke(): Promise<void> {
  const id = `__smoke_${randomUUID()}`;
  const dir = songDir(id);
  await mkdir(dir, { recursive: true });

  const meta: SongMeta = {
    id,
    title: 'Smoke Test Song',
    artist: 'Tester',
    sourceUrl: 'https://example.com/smoke',
    durationMs: 1234,
    createdAt: new Date().toISOString(),
  };

  try {
    await writeMeta(id, meta);
    await writeFile(audioPath(id), 'stub audio bytes', 'utf8');
    await writeFile(
      chartPath(id),
      `${JSON.stringify({ version: 1, audioOffsetMs: 0, notes: [] }, null, 2)}\n`,
      'utf8',
    );

    const complete = await songIsComplete(id);
    assert.equal(complete, true, 'songIsComplete should be true');

    const listed = await listSongs();
    const found = listed.find((s) => s.id === id);
    assert.ok(found, 'listSongs should include the stub song');
    assert.equal(found?.title, 'Smoke Test Song');
    assert.equal(found?.artist, 'Tester');
    assert.equal(found?.durationMs, 1234);

    await deleteSong(id);
    const stillComplete = await songIsComplete(id);
    assert.equal(stillComplete, false, 'songIsComplete should be false after delete');

    const afterDelete = await listSongs();
    assert.ok(
      !afterDelete.find((s) => s.id === id),
      'listSongs should no longer include the song',
    );

    // Idempotent delete should not throw.
    await deleteSong(id);

    console.log('[store.smoke] ok');
  } catch (err) {
    // Best-effort cleanup on failure.
    await deleteSong(id).catch(() => undefined);
    throw err;
  }
}

const isMain = (() => {
  try {
    const url = new URL(import.meta.url);
    return process.argv[1] !== undefined && url.pathname === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  runStoreSmoke().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[store.smoke] error: ${message}`);
    process.exit(1);
  });
}
