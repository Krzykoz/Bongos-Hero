/**
 * Synthetic SFX bank for Bongos Hero.
 *
 * At module-init time we render a handful of one-shot samples into
 * `AudioBuffer`s using `OfflineAudioContext`, then publish them to a shared
 * `SfxEngine`. No binary assets, no extra deps. The rendering math is
 * deterministic — the noise generator uses a fixed mulberry32 seed so two
 * builds always sound identical.
 *
 * `SfxEngine.load(id, url)` only takes URLs, so we serialise each rendered
 * buffer to a WAV blob and hand back a `URL.createObjectURL(blob)` to load.
 * This avoids reaching into `SfxEngine`'s private buffer map (it stays a
 * read-only API from this module's perspective).
 */

import { SfxEngine } from './sfx.js';

export type SfxId =
  | 'hit-perfect'
  | 'hit-great'
  | 'hit-good'
  | 'miss'
  | 'sp-activate'
  | 'metronome-tick';

export interface SfxBank {
  /** The shared SfxEngine, ready to play(). */
  engine: SfxEngine;
  /** Rendered durations in ms, for reference. */
  durations: Record<SfxId, number>;
}

interface OfflineAudioContextCtor {
  new (numChannels: number, length: number, sampleRate: number): OfflineAudioContext;
}

interface WebkitWindow {
  OfflineAudioContext?: OfflineAudioContextCtor;
  webkitOfflineAudioContext?: OfflineAudioContextCtor;
}

const SAMPLE_RATE = 44_100;

interface SampleSpec {
  id: SfxId;
  durationMs: number;
  render(buf: Float32Array, sr: number): void;
}

const SAMPLE_SPECS: readonly SampleSpec[] = [
  {
    id: 'hit-perfect',
    durationMs: 120,
    render: (buf, sr) => renderHitTok(buf, sr, { ping: 1200, pingMs: 60, decayMs: 80, noiseGain: 0.6, pingGain: 0.55 }),
  },
  {
    id: 'hit-great',
    durationMs: 110,
    render: (buf, sr) => renderHitTok(buf, sr, { ping: 900, pingMs: 45, decayMs: 70, noiseGain: 0.55, pingGain: 0.4 }),
  },
  {
    id: 'hit-good',
    durationMs: 100,
    render: (buf, sr) => renderHitThump(buf, sr),
  },
  {
    id: 'miss',
    durationMs: 220,
    render: (buf, sr) => renderMiss(buf, sr),
  },
  {
    id: 'sp-activate',
    durationMs: 600,
    render: (buf, sr) => renderChime(buf, sr),
  },
  {
    id: 'metronome-tick',
    durationMs: 50,
    render: (buf, sr) => renderTick(buf, sr),
  },
];

/**
 * Public entry point: build the bank, return an SfxEngine with every sample
 * pre-loaded under its `SfxId`. Resolves once every sample is decoded.
 */
export async function buildSfxBank(ctx: AudioContext): Promise<SfxBank> {
  const engine = new SfxEngine({ ctx });
  const durations = {} as Record<SfxId, number>;
  const blobUrls: string[] = [];

  try {
    await Promise.all(
      SAMPLE_SPECS.map(async (spec) => {
        const buf = await renderSampleToBuffer(spec);
        durations[spec.id] = (buf.length / buf.sampleRate) * 1000;
        const blob = bufferToWavBlob(buf);
        const url = URL.createObjectURL(blob);
        blobUrls.push(url);
        await engine.load(spec.id, url);
      }),
    );
  } finally {
    // SfxEngine.load() decoded the blob already; the URLs can be released.
    for (const url of blobUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
  }

  return { engine, durations };
}

// ---- sample synthesis -------------------------------------------------------

function resolveOfflineCtor(): OfflineAudioContextCtor {
  const w = globalThis as unknown as WebkitWindow;
  const Ctor = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!Ctor) {
    throw new Error('OfflineAudioContext is not supported in this environment.');
  }
  return Ctor;
}

async function renderSampleToBuffer(spec: SampleSpec): Promise<AudioBuffer> {
  const length = Math.max(1, Math.round((spec.durationMs / 1000) * SAMPLE_RATE));
  const Ctor = resolveOfflineCtor();
  const oac = new Ctor(1, length, SAMPLE_RATE);
  const data = new Float32Array(length);
  spec.render(data, SAMPLE_RATE);

  const ab = oac.createBuffer(1, length, SAMPLE_RATE);
  ab.copyToChannel(data, 0);
  const src = oac.createBufferSource();
  src.buffer = ab;
  src.connect(oac.destination);
  src.start(0);
  return oac.startRendering();
}

interface HitTokParams {
  ping: number;
  pingMs: number;
  decayMs: number;
  noiseGain: number;
  pingGain: number;
}

function renderHitTok(buf: Float32Array, sr: number, p: HitTokParams): void {
  const rng = mulberry32(0x1337);
  const attackSamples = Math.round((8 / 1000) * sr);
  const decaySamples = Math.round((p.decayMs / 1000) * sr);
  const noiseEnd = attackSamples + decaySamples;
  const pingSamples = Math.round((p.pingMs / 1000) * sr);

  for (let i = 0; i < buf.length; i++) {
    let s = 0;
    if (i < noiseEnd) {
      const env = i < attackSamples
        ? i / Math.max(1, attackSamples)
        : Math.exp(-(i - attackSamples) / Math.max(1, decaySamples * 0.4));
      s += (rng() * 2 - 1) * env * p.noiseGain;
    }
    if (i < pingSamples) {
      const t = i / sr;
      const env = Math.exp(-i / Math.max(1, pingSamples * 0.45));
      s += Math.sin(2 * Math.PI * p.ping * t) * env * p.pingGain;
    }
    buf[i] = clipSoft(s);
  }
}

function renderHitThump(buf: Float32Array, sr: number): void {
  const rng = mulberry32(0xc0ffee);
  const attackSamples = Math.round((6 / 1000) * sr);
  const decaySamples = Math.round((90 / 1000) * sr);
  const cutoff = 700; // Hz one-pole low-pass
  const a = lpAlpha(cutoff, sr);
  let prev = 0;

  for (let i = 0; i < buf.length; i++) {
    const noise = rng() * 2 - 1;
    prev = prev + a * (noise - prev);
    const env = i < attackSamples
      ? i / Math.max(1, attackSamples)
      : Math.exp(-(i - attackSamples) / Math.max(1, decaySamples * 0.5));
    buf[i] = clipSoft(prev * env * 0.8);
  }
}

function renderMiss(buf: Float32Array, sr: number): void {
  const rng = mulberry32(0xdeadbeef);
  const cutoff = 500;
  const a = lpAlpha(cutoff, sr);
  let prev = 0;
  const totalMs = (buf.length / sr) * 1000;

  for (let i = 0; i < buf.length; i++) {
    const t = i / sr;
    const tMs = t * 1000;
    const k = Math.min(1, tMs / totalMs);
    // Sweep 200 → 80 Hz over the sample.
    const freq = 200 + (80 - 200) * k;
    // Slowly tighten the LP for a duller tail.
    const dynA = a * (1 - 0.5 * k);
    const noise = rng() * 2 - 1;
    prev = prev + dynA * (noise - prev);
    const env = Math.exp(-i / Math.max(1, sr * 0.12));
    const sweep = Math.sin(2 * Math.PI * freq * t);
    const s = sweep * env * 0.5 + prev * env * 0.4;
    buf[i] = clipSoft(s);
  }
}

function renderChime(buf: Float32Array, sr: number): void {
  const partials: ReadonlyArray<{ f: number; g: number }> = [
    { f: 660, g: 0.5 },
    { f: 990, g: 0.35 },
    { f: 1320, g: 0.22 },
  ];
  const tau = sr * 0.18; // exponential decay constant in samples

  for (let i = 0; i < buf.length; i++) {
    const t = i / sr;
    const env = Math.exp(-i / tau);
    let s = 0;
    for (const p of partials) {
      s += Math.sin(2 * Math.PI * p.f * t) * p.g;
    }
    buf[i] = clipSoft(s * env * 0.6);
  }
}

function renderTick(buf: Float32Array, sr: number): void {
  const rng = mulberry32(0x5eed);
  const clickSamples = Math.round((3 / 1000) * sr);
  const decaySamples = Math.round((40 / 1000) * sr);

  for (let i = 0; i < buf.length; i++) {
    const t = i / sr;
    const sine = Math.sin(2 * Math.PI * 1500 * t);
    const env = Math.exp(-i / Math.max(1, decaySamples * 0.35));
    let s = sine * env * 0.55;
    if (i < clickSamples) {
      s += (rng() * 2 - 1) * (1 - i / clickSamples) * 0.4;
    }
    buf[i] = clipSoft(s);
  }
}

// ---- helpers ----------------------------------------------------------------

/** Soft saturating limiter to keep peaks below 1.0 without harsh clipping. */
function clipSoft(x: number): number {
  if (x > 1) return 1;
  if (x < -1) return -1;
  return Math.tanh(x);
}

/** Coefficient for a one-pole low-pass at `cutoff` Hz, sample-rate `sr`. */
function lpAlpha(cutoff: number, sr: number): number {
  const dt = 1 / sr;
  const rc = 1 / (2 * Math.PI * cutoff);
  return dt / (rc + dt);
}

/** Deterministic 32-bit PRNG → float in [0,1). */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Encode an `AudioBuffer` as a 16-bit PCM WAV blob. Mono only (and that's
 * all we need — every sample in this bank is one channel).
 */
export function bufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = 1;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const bytesPerSample = 2;
  const dataBytes = length * numChannels * bytesPerSample;
  const headerBytes = 44;
  const totalBytes = headerBytes + dataBytes;

  const ab = new ArrayBuffer(totalBytes);
  const view = new DataView(ab);

  // RIFF header.
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, totalBytes - 8, true);
  writeAscii(view, 8, 'WAVE');

  // fmt chunk.
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);             // PCM chunk size
  view.setUint16(20, 1, true);              // format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true);              // block align
  view.setUint16(34, bytesPerSample * 8, true);                        // bits per sample

  // data chunk.
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  const channel = buffer.getChannelData(0);
  let offset = headerBytes;
  for (let i = 0; i < length; i++) {
    const sample = channel[i];
    const clamped = sample === undefined ? 0 : Math.max(-1, Math.min(1, sample));
    const intSample = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(offset, intSample, true);
    offset += 2;
  }

  return new Blob([ab], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i) & 0xff);
  }
}
