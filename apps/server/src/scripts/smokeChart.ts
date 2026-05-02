import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { extractOnsetFeatures } from '../audioFeatures.js';
import { buildChart } from '../chart.js';
import { detectOnsets } from '../onsets.js';

async function main(): Promise<void> {
  const audio = process.argv[2];
  if (!audio) {
    console.error('Usage: tsx apps/server/src/scripts/smokeChart.ts <audio-path>');
    process.exit(2);
  }

  console.error(`[smokeChart] audio: ${audio}`);

  const onsets = await detectOnsets({ audioPath: audio });
  console.error(`[smokeChart] aubioonset found ${onsets.timesSec.length} onsets`);

  const features = await extractOnsetFeatures({
    audioPath: audio,
    onsetsSec: onsets.timesSec,
  });
  console.error(
    `[smokeChart] decoded sr=${features.sampleRate} dur=${features.durationSec.toFixed(2)}s ch=${features.channelCount}`,
  );

  const chart = buildChart({ features });

  const total = onsets.timesSec.length;
  const kept = chart.notes.length;
  const lCount = chart.notes.filter((n) => n.lane === 'L').length;
  const rCount = kept - lCount;
  const lPct = kept > 0 ? ((lCount / kept) * 100).toFixed(1) : '0.0';
  const rPct = kept > 0 ? ((rCount / kept) * 100).toFixed(1) : '0.0';
  const spCount = chart.notes.filter((n) => n.sp === true).length;
  const bpmStr = chart.bpm !== undefined ? String(chart.bpm) : 'n/a';

  console.error(
    `[smokeChart] onsets=${total} kept=${kept} L=${lCount} (${lPct}%) R=${rCount} (${rPct}%) sp=${spCount} bpm=${bpmStr}`,
  );

  const outPath = path.join(path.dirname(path.resolve(audio)), 'chart.json');
  await writeFile(outPath, `${JSON.stringify(chart, null, 2)}\n`, 'utf8');
  console.error(`[smokeChart] wrote ${outPath}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[smokeChart] error: ${message}`);
  process.exit(1);
});
