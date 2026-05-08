// Per-workspace Vitest config. Server runs on Node and the production code uses
// NodeNext-style `.js` relative imports; Vitest's Vite-powered loader resolves
// these transparently.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
