import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface TranscodeOptions {
  inputPath: string;
  outputPath: string;
  /** EBU R128 integrated loudness target in LUFS (default -16). */
  loudnessLufs?: number;
}

export interface TranscodeResult {
  durationMs: number;
}

function tailBytes(buf: string, maxBytes: number): string {
  const b = Buffer.from(buf, 'utf8');
  if (b.length <= maxBytes) return buf;
  return b.subarray(b.length - maxBytes).toString('utf8');
}

async function probeDurationMs(outputPath: string): Promise<number> {
  try {
    const { stdout } = await execFileP(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        outputPath,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const seconds = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(seconds)) {
      throw new Error(`ffprobe returned non-numeric duration: ${JSON.stringify(stdout)}`);
    }
    return Math.round(seconds * 1000);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const tail = tailBytes(e.stderr ?? String(err), 4096);
    throw new Error(`ffprobe failed for ${outputPath}:\n${tail}`);
  }
}

export async function transcodeToOgg(opts: TranscodeOptions): Promise<TranscodeResult> {
  const lufs = opts.loudnessLufs ?? -16;
  const args = [
    '-y',
    '-i',
    opts.inputPath,
    '-af',
    `loudnorm=I=${lufs}:TP=-1.5:LRA=11`,
    '-c:a',
    'libopus',
    '-b:a',
    '128k',
    opts.outputPath,
  ];

  try {
    await execFileP('ffmpeg', args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: number | string };
    const tail = tailBytes(e.stderr ?? String(err), 4096);
    throw new Error(`ffmpeg transcode failed (exit ${String(e.code ?? 'null')}):\n${tail}`);
  }

  const durationMs = await probeDurationMs(opts.outputPath);
  return { durationMs };
}
