import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    exclude: [
      'node_modules/**',
      'output/**',
      'out/**',
      'dist/**',
      'public/vendor/**',
      'coverage/**',
      // Open-source snapshot note: this test validates the maintainer's private
      // workspace instruction file (CLAUDE.md) and its handoff-doc read-order rules.
      // That file is not part of the public snapshot, so the test cannot run here.
      'tests/unit/noe-handoff-consistency.test.js',
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
