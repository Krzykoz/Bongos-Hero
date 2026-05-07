import { spawn } from 'node:child_process';

export interface OnsetFeature {
  tSec: number;
  /** Range −1..+1: −1 = strongly left, +1 = strongly right, 0 = centered/mono. */
  stereoBalance: number;
  /** Hz, the centroid of the magnitude spectrum in the analysis window. */
  spectralCentroidHz: number;
  /** Total RMS energy in the window (used to drop ghost onsets). */
  rms: number;
}

export interface ExtractFeaturesOptions {
  /** Path to the OGG/Opus file. */
  audioPath: string;
  /** Sorted onset times in seconds. */
  onsetsSec: number[];
  /** Analysis window length around each onset, in ms. Default 60. */
  windowMs?: number;
}

export interface FeatureSet {
  sampleRate: number;
  durationSec: number;
  channelCount: number;
  features: OnsetFeature[];
}

const TARGET_SR = 22050;
const TARGET_CHANNELS = 2;
const EPS = 1e-9;

function tailBytes(buf: string, maxBytes: number): string {
  const b = Buffer.from(buf, 'utf8');
  if (b.length <= maxBytes) return buf;
  return b.subarray(b.length - maxBytes).toString('utf8');
}

/**
 * Decode the audio file to interleaved stereo float32 PCM at TARGET_SR Hz
 * via ffmpeg, returning a single contiguous Float32Array.
 */
function decodePcm(audioPath: string): Promise<Float32Array> {
  return new Promise<Float32Array>((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-i',
      audioPath,
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      '-ac',
      String(TARGET_CHANNELS),
      '-ar',
      String(TARGET_SR),
      '-',
    ];

    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let stderrBuf = '';

    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-32 * 1024);
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg for PCM decode: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const tail = tailBytes(stderrBuf, 4096);
        reject(new Error(`ffmpeg PCM decode failed (exit ${code ?? 'null'}):\n${tail}`));
        return;
      }
      // Buffer.concat gives us one big Buffer, but its underlying ArrayBuffer
      // is rarely 4-byte-aligned. Copy bytes into a fresh aligned Uint8Array
      // so we can safely create a Float32Array view over it.
      const merged = Buffer.concat(chunks, totalBytes);
      const aligned = new Uint8Array(merged.byteLength);
      aligned.set(merged);
      const floats = new Float32Array(
        aligned.buffer,
        aligned.byteOffset,
        Math.floor(aligned.byteLength / 4),
      );
      resolve(floats);
    });
  });
}

/**
 * In-place iterative radix-2 Cooley–Tukey FFT.
 * `re` and `im` must both have length N where N is a power of two.
 * Computes the forward DFT: X[k] = Σ x[n] · exp(-2πi · k · n / N).
 */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;

  // Bit-reverse permutation.
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) {
      j &= ~bit;
    }
    j |= bit;
    if (i < j) {
      const tr = re[i]!;
      const ti = im[i]!;
      re[i] = re[j]!;
      im[i] = im[j]!;
      re[j] = tr;
      im[j] = ti;
    }
  }

  // Cooley–Tukey butterflies.
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angleStep = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const angle = angleStep * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const aIdx = start + k;
        const bIdx = start + k + half;
        const ar = re[aIdx]!;
        const ai = im[aIdx]!;
        const br = re[bIdx]!;
        const bi = im[bIdx]!;
        // t = w * b
        const tr = wr * br - wi * bi;
        const ti = wr * bi + wi * br;
        re[aIdx] = ar + tr;
        im[aIdx] = ai + ti;
        re[bIdx] = ar - tr;
        im[bIdx] = ai - ti;
      }
    }
  }
}

function nextPow2(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Compute spectral centroid (Hz) of a real-valued mono window using a
 * Hann-windowed, zero-padded FFT.
 */
function spectralCentroidHz(mono: Float32Array, sampleRate: number): number {
  if (mono.length === 0) return 0;
  const fftSize = nextPow2(mono.length);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  // Hann window over the original (non-padded) samples.
  const denom = mono.length > 1 ? mono.length - 1 : 1;
  for (let i = 0; i < mono.length; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
    re[i] = mono[i]! * w;
  }
  fftInPlace(re, im);

  // Only the lower half of the spectrum is unique for real input.
  const half = fftSize >> 1;
  const binHz = sampleRate / fftSize;
  let weighted = 0;
  let total = 0;
  for (let k = 0; k < half; k++) {
    const r = re[k]!;
    const i = im[k]!;
    const mag = Math.sqrt(r * r + i * i);
    weighted += k * binHz * mag;
    total += mag;
  }
  if (total < EPS) return 0;
  return weighted / total;
}

function rmsOf(buf: Float32Array): number {
  if (buf.length === 0) return 0;
  let sumSq = 0;
  for (const v of buf) {
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / buf.length);
}

export async function extractOnsetFeatures(opts: ExtractFeaturesOptions): Promise<FeatureSet> {
  const windowMs = opts.windowMs ?? 60;
  const pcm = await decodePcm(opts.audioPath);

  const sampleRate = TARGET_SR;
  const channels = TARGET_CHANNELS;
  const totalFrames = Math.floor(pcm.length / channels);
  const durationSec = totalFrames / sampleRate;
  const winLen = Math.max(1, Math.floor((windowMs / 1000) * sampleRate));

  const features: OnsetFeature[] = [];

  // Reusable scratch buffers per-onset (sized to winLen).
  const left = new Float32Array(winLen);
  const right = new Float32Array(winLen);
  const mono = new Float32Array(winLen);

  for (const tSec of opts.onsetsSec) {
    const startFrame = Math.max(0, Math.floor(tSec * sampleRate));
    const endFrame = Math.min(totalFrames, startFrame + winLen);
    const len = endFrame - startFrame;

    if (len <= 0) {
      features.push({
        tSec,
        stereoBalance: 0,
        spectralCentroidHz: 0,
        rms: 0,
      });
      continue;
    }

    // Slice channels out of the interleaved buffer.
    for (let i = 0; i < len; i++) {
      const baseIdx = (startFrame + i) * channels;
      const l = pcm[baseIdx]!;
      const r = pcm[baseIdx + 1]!;
      left[i] = l;
      right[i] = r;
      mono[i] = (l + r) * 0.5;
    }
    // Zero out any unused tail (when window is clipped at end of file).
    for (let i = len; i < winLen; i++) {
      left[i] = 0;
      right[i] = 0;
      mono[i] = 0;
    }

    const lView = left.subarray(0, len);
    const rView = right.subarray(0, len);
    const mView = mono.subarray(0, len);

    const rmsL = rmsOf(lView);
    const rmsR = rmsOf(rView);
    const rms = rmsOf(mView);
    const stereoBalance = (rmsR - rmsL) / (rmsR + rmsL + EPS);
    const centroid = spectralCentroidHz(mView, sampleRate);

    features.push({
      tSec,
      stereoBalance,
      spectralCentroidHz: centroid,
      rms,
    });
  }

  return {
    sampleRate,
    durationSec,
    channelCount: channels,
    features,
  };
}
