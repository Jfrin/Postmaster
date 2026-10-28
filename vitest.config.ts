import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/types.ts', 'src/logger.ts'],
      reporter: ['text', 'lcov'],
      thresholds: { lines: 85, functions: 85, statements: 85, branches: 75 },
    },
  },
});
