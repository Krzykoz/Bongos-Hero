import { AudioEngine } from './engine.js';
import type { EngineState } from './engine.js';
import { loadAudioOffsetMs, saveAudioOffsetMs } from './latency.js';

/**
 * Tiny in-browser smoke test for the audio engine. Not auto-imported from
 * main.ts — call this manually from the browser console if you want to
 * sanity-check after a refactor. Does NOT touch the network or the
 * AudioContext, so it's safe to run before any user gesture.
 */
export function runEngineSmoke(): void {
  const eng = new AudioEngine();

  if (eng.state !== 'idle') {
    throw new Error(`expected initial state 'idle', got '${eng.state}'`);
  }
  if (eng.currentTimeMs() !== 0) {
    throw new Error(`expected initial currentTimeMs() === 0, got ${eng.currentTimeMs()}`);
  }
  if (eng.durationMs !== 0) {
    throw new Error(`expected initial durationMs === 0, got ${eng.durationMs}`);
  }

  // Subscribe / unsubscribe contract.
  const seen: EngineState[] = [];
  const unsub = eng.onStateChange((s) => seen.push(s));
  if (typeof unsub !== 'function') {
    throw new Error('onStateChange must return an unsubscribe function');
  }
  unsub();
  unsub(); // idempotent

  const unsubEnded = eng.onEnded(() => {
    /* noop */
  });
  if (typeof unsubEnded !== 'function') {
    throw new Error('onEnded must return an unsubscribe function');
  }
  unsubEnded();

  // Methods must be safe to call in any state — these are all no-ops in idle.
  eng.pause();
  eng.stop();

  // Calibration offset is reflected immediately.
  eng.setAudioOffsetMs(42);
  if (eng.currentTimeMs() !== 42) {
    throw new Error(
      `expected currentTimeMs() === 42 after setAudioOffsetMs(42), got ${eng.currentTimeMs()}`,
    );
  }

  // latency.ts: round-trip + clamping.
  saveAudioOffsetMs(99999);
  if (loadAudioOffsetMs() !== 300) {
    throw new Error(`expected clamped offset 300, got ${loadAudioOffsetMs()}`);
  }
  saveAudioOffsetMs(-99999);
  if (loadAudioOffsetMs() !== -300) {
    throw new Error(`expected clamped offset -300, got ${loadAudioOffsetMs()}`);
  }
  saveAudioOffsetMs(0);

  console.log('smoke ok');
}
