// Per-workspace Vitest config. We use one config per workspace (rather than a
// single root config with `projects`) because each workspace has different
// module-resolution conventions (server: NodeNext, web: Bundler) and only the
// per-workspace approach lets each test suite inherit the same resolution
// rules its production code uses, avoiding subtle import-extension mismatches.
//
// Shared is pure logic (constants + types) — Node environment is sufficient.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
