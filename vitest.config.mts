import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    pool: 'forks',
    isolate: true,
    maxWorkers: 4,
    testTimeout: 15000,
    hookTimeout: 15000,
    restoreMocks: true,
    clearMocks: true,
    allowOnly: false,
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
    },
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/*/tests/**/*.test.ts', 'apps/desktop/tests/**/*.test.ts', 'tests/**/*.test.ts'],
          exclude: ['**/*.component.test.*', '**/*.artifact.test.*'],
        },
      },
      {
        test: {
          name: 'component',
          environment: 'jsdom',
          include: ['packages/*/tests/**/*.component.test.tsx'],
          setupFiles: ['tests/fixtures/component-setup.ts'],
        },
      },
    ],
  },
})
