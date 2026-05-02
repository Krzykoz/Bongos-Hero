import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import type { SongMeta } from '@bongos-hero/shared';

import { extractOnsetFeatures } from '../audioFeatures.js';
import { buildChart } from '../chart.js';
import { detectOnsets } from '../onsets.js';
import { audioPath, chartPath, metaPath, songDir } from '../paths.js';
import { checkPrereqs } from '../prereqs.js';
import { transcodeToOgg } from '../transcode.js';
import { downloadAudio } from '../ytdlp.js';

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: tsx apps/server/src/scripts/smokePipeline.ts <url>');
    process.exit(2);
  }

  const versions = await checkPrereqs();
  console.error(
    `[prereqs] yt-dlp=${versions.ytdlp} ffmpeg=${versions.ffmpeg.slice(0, 60)} aubioonset=${versions.aubioonset}`,
  );

  const id = randomUUID();
  const dir = songDir(id);
  await mkdir(dir, { recursive: true });
  console.error(`[smoke] song id ${id}`);
  console.error(`[smoke] dir   ${dir}`);

  const dl = await downloadAudio({
    url,
    destDir: dir,
    onProgress: (p) => {
      process.stderr.write(`\r[download] ${(p * 100).toFixed(1)}%   `);
    },
  });
  process.stderr.write('\n');
  console.error(`[smoke] downloaded "${dl.title}" (${dl.durationMs} ms reported by yt-dlp)`);

  const out = audioPath(id);
  const { durationMs } = await transcodeToOgg({
    inputPath: dl.rawAudioPath,
    outputPath: out,
  });
  console.error(`[smoke] transcoded -> ${out} (${durationMs} ms)`);

  const meta: SongMeta = {
    id,
    title: dl.title,
    sourceUrl: dl.sourceUrl,
    durationMs,
    createdAt: new Date().toISOString(),
  };
  if (dl.artist !== undefined) meta.artist = dl.artist;

  await writeFile(metaPath(id), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  await rm(dl.rawAudioPath, { force: true });
  console.error('[smoke] cleaned up raw download');

  const onsets = await detectOnsets({ audioPath: out });
  const features = await extractOnsetFeatures({
    audioPath: out,
    onsetsSec: onsets.timesSec,
  });
  const chart = buildChart({ features });
  await writeFile(chartPath(id), `${JSON.stringify(chart, null, 2)}\n`, 'utf8');
  const bpmStr = chart.bpm !== undefined ? String(chart.bpm) : 'n/a';
  console.error(`[smoke] chart ok: ${chart.notes.length} notes, ~${bpmStr} bpm`);

  process.stdout.write(`${JSON.stringify(meta, null, 2)}\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[smoke] error: ${message}`);
  process.exit(1);
});
