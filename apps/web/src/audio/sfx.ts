/**
 * Tiny one-shot sample player for UI / hit feedback. Shares the AudioContext
 * with the master `AudioEngine` so everything sits on a single clock.
 *
 * One-shots are allowed (and expected) to overlap, so each `play()` builds a
 * fresh `AudioBufferSourceNode` and lets the GC collect it after `onended`.
 *
 * The engine self-registers a per-key applier against the user settings
 * store at construction so SFX volume changes propagate live without
 * callers having to wire anything up.
 */

import { register as registerSetting } from '../settings/index.js';

export interface SfxEngineOptions {
  ctx: AudioContext;
  /** Master gain in [0, 1] (or higher, at your peril). Default 1. */
  volume?: number;
}

export interface SfxPlayOptions {
  /** Per-shot gain multiplier (multiplied with master). Default 1. */
  gain?: number;
  /** Playback rate; doubles as pitch for short samples. Default 1. */
  rate?: number;
}

export class SfxEngine {
  private readonly _ctx: AudioContext;
  private readonly _master: GainNode;
  private readonly _buffers = new Map<string, AudioBuffer>();
  private readonly _missingWarned = new Set<string>();

  constructor(opts: SfxEngineOptions) {
    this._ctx = opts.ctx;
    this._master = this._ctx.createGain();
    this._master.gain.value = opts.volume ?? 1;
    this._master.connect(this._ctx.destination);
    // Per-key registration against the settings store. `register()` invokes
    // the applier synchronously with the current value, which seeds the
    // master gain to the persisted SFX volume (overriding `opts.volume`).
    registerSetting('sfxVolume', (v) => {
      this.setMasterVolume(v);
    });
  }

  /** Loads a one-shot sample by id. Resolves once decoded. */
  async load(id: string, url: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`SfxEngine.load("${id}"): HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    const arr = await res.arrayBuffer();
    const buf = await this._ctx.decodeAudioData(arr);
    this._buffers.set(id, buf);
    // Allow the warning to fire again if this id is unloaded later.
    this._missingWarned.delete(id);
  }

  /** Plays a previously loaded sample. Cheap; allowed to overlap. */
  play(id: string, opts: SfxPlayOptions = {}): void {
    const buf = this._buffers.get(id);
    if (!buf) {
      if (!this._missingWarned.has(id)) {
        this._missingWarned.add(id);
        console.warn(`[SfxEngine] play("${id}"): sample not loaded — ignoring (warned once).`);
      }
      return;
    }

    const src = this._ctx.createBufferSource();
    src.buffer = buf;
    if (opts.rate != null && Number.isFinite(opts.rate) && opts.rate > 0) {
      src.playbackRate.value = opts.rate;
    }

    let tail: AudioNode = src;
    if (opts.gain != null && Number.isFinite(opts.gain)) {
      const g = this._ctx.createGain();
      g.gain.value = opts.gain;
      src.connect(g);
      tail = g;
    }
    tail.connect(this._master);

    // Self-cleanup so per-shot nodes don't leak once they finish.
    src.onended = (): void => {
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
      if (tail !== src) {
        try {
          (tail as GainNode).disconnect();
        } catch {
          /* ignore */
        }
      }
    };

    src.start();
  }

  /** Sets master volume, clamped to [0, 1]. */
  setMasterVolume(v: number): void {
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(0, Math.min(1, v));
    this._master.gain.value = clamped;
  }

  /**
   * Synthesised "celebratory chord" for the 5★ results stinger. Three
   * oscillators voice a major triad (C5 / E5 / G5) with small detuning so
   * the chord shimmers, plus a fast attack + smooth exponential decay over
   * ~600 ms. Routed through the shared `_master` gain so the final level
   * still respects the user's `sfxVolume` setting.
   *
   * No samples, no buffers, no asset adds — pure Web Audio nodes that the
   * scheduler tears down on `onended`.
   */
  playStinger(): void {
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const totalSec = 0.6;

    const env = ctx.createGain();
    // exponentialRampToValueAtTime requires strictly positive endpoints.
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(0.7, now + 0.06);
    env.gain.exponentialRampToValueAtTime(0.0001, now + totalSec);
    env.connect(this._master);

    const freqs = [523.25, 659.25, 783.99];
    const detunes = [-6, 0, 6];
    let lastOsc: OscillatorNode | null = null;
    for (let i = 0; i < freqs.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      // `freqs` and `detunes` are constant tuples; the `??` fallback keeps
      // `noUncheckedIndexedAccess` happy without runtime cost.
      osc.frequency.value = freqs[i] ?? 440;
      osc.detune.value = detunes[i] ?? 0;
      osc.connect(env);
      osc.start(now);
      osc.stop(now + totalSec + 0.05);
      lastOsc = osc;
    }

    // Detach the envelope after the last oscillator stops so this transient
    // graph does not stay connected to the master bus.
    if (lastOsc) {
      lastOsc.onended = (): void => {
        try {
          env.disconnect();
        } catch {
          /* ignore */
        }
      };
    }
  }

  /**
   * Synthesised "fail beat" for the 0★ / failed results screen. Single
   * 100 Hz sine oscillator with a fast attack and a 200 ms exponential
   * decay — sounds like a low sympathetic thump rather than a punishing
   * buzzer. Routed through `_master` so it follows `sfxVolume`.
   */
  playFailBeat(): void {
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const decaySec = 0.2;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(0.6, now + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, now + decaySec);
    env.connect(this._master);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 100;
    osc.connect(env);
    osc.start(now);
    osc.stop(now + decaySec + 0.05);
    osc.onended = (): void => {
      try {
        env.disconnect();
      } catch {
        /* ignore */
      }
    };
  }
}
