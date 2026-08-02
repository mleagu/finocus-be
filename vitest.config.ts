import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Jest-style globals, so the suites ported over from the app run unchanged.
    globals: true,
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
