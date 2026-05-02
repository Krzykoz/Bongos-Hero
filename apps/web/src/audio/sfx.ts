/**
 * Tiny one-shot sample player for UI / hit feedback. Shares the AudioContext
 * with the master `AudioEngine` so everything sits on a single clock.
 *
 * One-shots are allowed (and expected) to overlap, so each `play()` builds a
 * fresh `AudioBufferSourceNode` and lets the GC collect it after `onended`.
 */

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

  /** Sets master volume. Values outside [0, 1] are accepted; caller's risk. */
  setMasterVolume(v: number): void {
    if (!Number.isFinite(v)) return;
    this._master.gain.value = v;
  }
}
