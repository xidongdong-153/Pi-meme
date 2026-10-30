import { defineConfig } from '@playwright/test'

const output = process.env.PI_MEME_TEST_REPORT_DIR ?? `out/tests/playwright/${Date.now()}-${process.pid}`
process.env.PI_MEME_TEST_REPORT_DIR = output

export default defineConfig({
  testDir: './apps',
  testMatch: '**/*.e2e.spec.ts',
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 120000,
  expect: { timeout: 10000 },
  outputDir: `${output}/artifacts`,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${output}/html`, open: 'never' }],
    ['json', { outputFile: `${output}/results.json` }],
  ],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 10000, navigationTimeout: 15000 },
  projects: [{ name: 'web', testMatch: '**/web/tests/**/*.e2e.spec.ts', use: { browserName: 'chromium' } }],
})
