import { execFile, spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface DownloadOptions {
  url: string;
  destDir: string;
  /** Called periodically with 0..1 download progress (best effort). Optional. */
  onProgress?: (p: number) => void;
}

export interface DownloadResult {
  /** Path to the raw downloaded audio file (whatever container yt-dlp produced). */
  rawAudioPath: string;
  /** Title pulled from yt-dlp metadata. */
  title: string;
  /** Channel name (if any). */
  artist?: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Original URL. */
  sourceUrl: string;
}

interface YtDlpInfo {
  title?: unknown;
  uploader?: unknown;
  channel?: unknown;
  duration?: unknown;
}

function tailBytes(buf: string, maxBytes: number): string {
  const b = Buffer.from(buf, 'utf8');
  if (b.length <= maxBytes) return buf;
  return b.subarray(b.length - maxBytes).toString('utf8');
}

const PROGRESS_RE = /\[download\]\s+([0-9]+(?:\.[0-9]+)?)%/;

async function fetchInfo(url: string): Promise<DownloadResult> {
  let json: string;
  try {
    const { stdout } = await execFileP('yt-dlp', ['-J', '--no-warnings', '--no-playlist', url], {
      maxBuffer: 64 * 1024 * 1024,
    });
    json = stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const tail = tailBytes(e.stderr ?? String(err), 4096);
    throw new Error(`yt-dlp metadata fetch failed:\n${tail}`);
  }

  let info: YtDlpInfo;
  try {
    info = JSON.parse(json) as YtDlpInfo;
  } catch (err) {
    throw new Error(`Failed to parse yt-dlp -J JSON output: ${(err as Error).message}`);
  }

  const title =
    typeof info.title === 'string' && info.title.length > 0 ? info.title : 'Unknown title';
  const artist =
    typeof info.uploader === 'string' && info.uploader.length > 0
      ? info.uploader
      : typeof info.channel === 'string' && info.channel.length > 0
        ? info.channel
        : undefined;
  const durationSec =
    typeof info.duration === 'number' && Number.isFinite(info.duration) ? info.duration : 0;
  const durationMs = Math.round(durationSec * 1000);

  const result: DownloadResult = {
    rawAudioPath: '',
    title,
    durationMs,
    sourceUrl: url,
  };
  if (artist !== undefined) result.artist = artist;
  return result;
}

function runDownload(opts: DownloadOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const args = [
      '-x',
      '--audio-format',
      'opus',
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '--progress',
      '-o',
      path.join(opts.destDir, 'raw.%(ext)s'),
      opts.url,
    ];

    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrBuf = '';
    let stdoutBuf = '';
    let lastProgress = -1;

    const handleLine = (line: string): void => {
      const m = PROGRESS_RE.exec(line);
      if (!m?.[1]) return;
      const pct = Number.parseFloat(m[1]);
      if (!Number.isFinite(pct)) return;
      const p = Math.max(0, Math.min(1, pct / 100));
      // Only fire when progress meaningfully advances to avoid log spam.
      if (p - lastProgress >= 0.005 || p === 1) {
        lastProgress = p;
        opts.onProgress?.(p);
      }
    };

    const makeLineHandler = (): ((chunk: Buffer) => void) => {
      let pending = '';
      return (chunk: Buffer): void => {
        pending += chunk.toString('utf8');
        let idx: number;
        while ((idx = pending.search(/\r|\n/)) !== -1) {
          const line = pending.slice(0, idx);
          pending = pending.slice(idx + 1);
          if (line.length > 0) handleLine(line);
        }
      };
    };

    const onStdout = makeLineHandler();
    const onStderr = makeLineHandler();

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      if (stdoutBuf.length > 64 * 1024) stdoutBuf = stdoutBuf.slice(-32 * 1024);
      onStdout(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-32 * 1024);
      onStderr(chunk);
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const combined = `${stderrBuf}\n${stdoutBuf}`;
      const tail = tailBytes(combined, 4096);
      reject(new Error(`yt-dlp download failed (exit ${code ?? 'null'}):\n${tail}`));
    });
  });
}

async function findRawFile(destDir: string): Promise<string> {
  const entries = await readdir(destDir);
  const match = entries.find((name) => name.startsWith('raw.'));
  if (!match) {
    throw new Error(`yt-dlp finished but no file starting with "raw." was found in ${destDir}`);
  }
  return path.join(destDir, match);
}

export async function downloadAudio(opts: DownloadOptions): Promise<DownloadResult> {
  const info = await fetchInfo(opts.url);
  await runDownload(opts);
  const rawAudioPath = await findRawFile(opts.destDir);
  return { ...info, rawAudioPath };
}
