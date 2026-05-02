import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface PrereqVersions {
  ytdlp: string;
  ffmpeg: string;
  aubioonset: string;
}

interface ProbeResult {
  ok: boolean;
  version: string;
}

const INSTALL_HINTS: Record<keyof PrereqVersions, { brew: string; apt: string }> = {
  ytdlp: {
    brew: 'brew install yt-dlp',
    apt: 'sudo apt install yt-dlp   # or: pipx install yt-dlp',
  },
  ffmpeg: {
    brew: 'brew install ffmpeg',
    apt: 'sudo apt install ffmpeg',
  },
  aubioonset: {
    brew: 'brew install aubio',
    apt: 'sudo apt install aubio-tools',
  },
};

async function probe(
  cmd: string,
  args: string[],
  parse: (stdout: string, stderr: string) => string,
): Promise<ProbeResult> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { maxBuffer: 1024 * 1024 });
    return { ok: true, version: parse(stdout, stderr) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    // Some tools (e.g. aubioonset) exit non-zero on --help but still print useful text.
    if ((e.stdout && e.stdout.length > 0) || (e.stderr && e.stderr.length > 0)) {
      try {
        return { ok: true, version: parse(e.stdout ?? '', e.stderr ?? '') };
      } catch {
        // fall through
      }
    }
    return { ok: false, version: '' };
  }
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/)[0];
  return line ? line.trim() : '';
}

export async function checkPrereqs(): Promise<PrereqVersions> {
  const [ytdlp, ffmpeg, aubio] = await Promise.all([
    probe('yt-dlp', ['--version'], (out) => firstLine(out) || 'ok'),
    probe('ffmpeg', ['-version'], (out) => firstLine(out) || 'ok'),
    // aubioonset prints usage to stderr and exits non-zero on -h; we only care that it runs.
    probe('aubioonset', ['-h'], () => 'ok'),
  ]);

  const missing: Array<keyof PrereqVersions> = [];
  if (!ytdlp.ok) missing.push('ytdlp');
  if (!ffmpeg.ok) missing.push('ffmpeg');
  if (!aubio.ok) missing.push('aubioonset');

  if (missing.length > 0) {
    const lines: string[] = [
      `Missing required binaries: ${missing.join(', ')}.`,
      '',
      'Install with Homebrew (macOS):',
      ...missing.map((m) => `  ${INSTALL_HINTS[m].brew}`),
      '',
      'Install with apt (Debian/Ubuntu):',
      ...missing.map((m) => `  ${INSTALL_HINTS[m].apt}`),
    ];
    throw new Error(lines.join('\n'));
  }

  return {
    ytdlp: ytdlp.version,
    ffmpeg: ffmpeg.version,
    aubioonset: aubio.version,
  };
}
