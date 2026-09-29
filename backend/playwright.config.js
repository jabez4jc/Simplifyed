/**
 * End-to-end configuration.
 *
 * The app under test runs against its own throwaway database (database/e2e.db, built from the
 * migration template in global-setup) and talks to a fake broker, so a run cannot touch the
 * developer's real data or place an order anywhere real.
 *
 * @type {import('@playwright/test').PlaywrightTestConfig}
 */
import { devices } from '@playwright/test';

const PORT = 3111; // deliberately not 3000 - a dev server may already be running there

const config = {
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  globalSetup: './e2e/global-setup.js',
  timeout: 30000,
  expect: { timeout: 7000 },
  fullyParallel: false, // the specs share one seeded database
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    actionTimeout: 0,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'node server.js',
    port: PORT,
    reuseExistingServer: false,
    timeout: 60000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      DATABASE_PATH: './database/e2e.db',
      NODE_ENV: 'test',
      // Explicitly OFF: the auth bypass would make every permission assertion meaningless.
      ENABLE_TEST_MODE: 'false',
    },
  },
};

export default config;
