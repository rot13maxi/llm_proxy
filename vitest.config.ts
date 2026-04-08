import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.ts'],
    // tests/e2e is run by Playwright (`npm run test:e2e`), not vitest.
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**'],
    deps: {
      interopDefault: true
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', 'dist', 'tests']
    }
  },
  resolve: {
    alias: {
      '~': new URL('./src/', import.meta.url).pathname
    }
  }
});
