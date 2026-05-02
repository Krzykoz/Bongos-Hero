import { KeyboardInput } from './keyboard.js';

/**
 * Tiny in-browser smoke test for the keyboard input layer. Not auto-imported
 * from main.ts — call this manually from the browser console if you want to
 * sanity-check after a refactor.
 */
export function runInputSmoke(): void {
  const input = new KeyboardInput({ getSongTimeMs: () => 12345 });

  if (input.isLanePressed('L') !== false) {
    throw new Error('expected isLanePressed("L") === false before attach');
  }

  input.attach();
  // Idempotent: a second call must not throw or add a duplicate listener.
  input.attach();

  input.detach();

  // eslint-disable-next-line no-console
  console.log('smoke ok');
}
