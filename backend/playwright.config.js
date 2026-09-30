/**
 * End-to-end configuration.
 *
 * The app under test runs against its own throwaway database (database/e2e.db, built from the
 * migration template by e2e/global-setup.js), so a run never writes the operator's real data.
 * The brokers are REAL: Jz Kotak, Jz Fyers and Jabez Crypto, copied from database/simplifyed.db,
 * all in analyzer mode. Specs that order confirm analyzer mode at the broker first and close
 * everything they opened (see e2e/broker.js).
 *
 * @type {import('@playwright/test').PlaywrightTestConfig}
 */
import { devices } from '@playwright/test';

const PORT = 3111; // deliberately not 3000 - a dev server may already be running there

const config = {
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  timeout: 30000,
  expect: { timeout: 7000 },
  fullyParallel: false, // the specs share one seeded database
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    // A hidden or missing control should fail in seconds, not hang until the test times out.
    actionTimeout: 15000,
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
    // The database is built HERE, before the server opens it. As a globalSetup it ran after
    // Playwright had already started the server, which kept serving the previous run's file
    // while setup swapped a fresh one in underneath it.
    command: 'node e2e/global-setup.js && node server.js',
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
      // Test orders must not message the operator's Telegram (dotenv never overrides a set var).
      TELEGRAM_BOT_TOKEN: '',
    },
  },
};

export default config;
