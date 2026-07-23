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
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
