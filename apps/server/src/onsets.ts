import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export type OnsetMethod =
  | 'specflux'
  | 'energy'
  | 'hfc'
  | 'complex'
  | 'phase'
  | 'specdiff'
  | 'kl'
  | 'mkl'
  | 'wphase';

export interface DetectOnsetsOptions {
  audioPath: string;
  /** aubioonset method, default 'specflux'. */
  method?: OnsetMethod;
  /** Peak picking threshold, default 0.3. */
  threshold?: number;
  /**
   * Minimum inter-onset interval (s), default 0.05.
   * Note: this value is only informational for the chart stage; aubioonset's
   * own `-s` flag is the silence threshold in dB (kept fixed at -90, the
   * quietest setting), and we apply our own minimum-spacing filter when
   * building the chart.
   */
  silence?: number;
}

export interface OnsetTimes {
  /** Sorted ascending onset times in seconds. */
  timesSec: number[];
}

function tailBytes(buf: string, maxBytes: number): string {
  const b = Buffer.from(buf, 'utf8');
  if (b.length <= maxBytes) return buf;
  return b.subarray(b.length - maxBytes).toString('utf8');
}

export async function detectOnsets(opts: DetectOnsetsOptions): Promise<OnsetTimes> {
  const method: OnsetMethod = opts.method ?? 'specflux';
  const threshold = opts.threshold ?? 0.3;
  // `silence` is intentionally unused at the binary level (see jsdoc above).
  void opts.silence;

  const args = ['-i', opts.audioPath, '-O', method, '-t', String(threshold), '-s', '-90'];

  let stdout: string;
  try {
    const result = await execFileP('aubioonset', args, { maxBuffer: 16 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: number | string };
    const tail = tailBytes(e.stderr ?? String(err), 4096);
    throw new Error(`aubioonset failed (exit ${String(e.code ?? 'null')}):\n${tail}`);
  }

  const times: number[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const t = Number.parseFloat(line);
    if (!Number.isFinite(t)) continue;
    times.push(t);
  }

  times.sort((a, b) => a - b);
  return { timesSec: times };
}
