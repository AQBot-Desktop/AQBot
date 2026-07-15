import { defineConfig, devices } from '@playwright/test';

const externalBaseUrl = process.env.PERF_BASE_URL;
const baseURL = externalBaseUrl ?? 'http://127.0.0.1:4173';
const browserChannel = process.env.PERF_BROWSER_CHANNEL;

export default defineConfig({
  testDir: './tests/performance',
  testMatch: '**/*.perf.spec.ts',
  outputDir: 'test-results/performance-artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/performance-results.json' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium-production',
      use: {
        browserName: 'chromium',
        ...(browserChannel ? { channel: browserChannel } : {}),
      },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: 'pnpm build && pnpm preview --host 127.0.0.1 --port 4173 --strictPort',
        url: baseURL,
        reuseExistingServer: false,
        timeout: 240_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
