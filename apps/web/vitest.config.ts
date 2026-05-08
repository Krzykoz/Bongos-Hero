// Per-workspace Vitest config. None of the listed pure-logic tests need the
// DOM, so we deliberately stick to `environment: 'node'` rather than pulling
// in `happy-dom`/`jsdom`. The web app uses Bundler module resolution; Vite's
// loader handles the `.js`-suffixed TS imports without extra plumbing.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
