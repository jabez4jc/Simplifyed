import { expect } from '@playwright/test';
import { ADMIN } from './global-setup.js';

export { ADMIN };

/**
 * Log in through the real form, not by injecting a token.
 *
 * Seeding localStorage directly would skip the one flow every user takes and would not catch a
 * broken login page, which is the most expensive possible regression.
 */
export async function login(page, credentials = ADMIN) {
  await page.goto('/login.html');
  await page.fill('#login-email', credentials.email);
  await page.fill('#login-password', credentials.password);
  await page.click('#login-btn');

  await page.waitForFunction(() => !!localStorage.getItem('auth_token'), null, { timeout: 15000 });
  await expect(page).not.toHaveURL(/login\.html/, { timeout: 15000 });
  await waitForApp(page);
}

/**
 * Wait until the dashboard's controller object exists.
 *
 * dashboard.html loads ~50 modules with `defer` and wires its buttons through inline
 * `onclick="app.…"` attributes, so the markup is clickable before `app` exists. A test that
 * clicks the instant the page appears gets "app is not defined" and no navigation - a race, not
 * a defect, but one that would otherwise make every spec here intermittently wrong.
 */
export async function waitForApp(page) {
  await page.waitForFunction(
    () => typeof window.app === 'object' && window.app !== null && typeof window.app.switchView === 'function',
    null,
    { timeout: 20000 }
  );
}

/**
 * Open the dashboard and wait until it has actually rendered.
 *
 * Deliberately NOT `waitForLoadState('networkidle')`. The dashboard holds an open connection to
 * the market-data feed and polls on a timer, so the network never goes quiet for the 500ms
 * networkidle requires - the wait can only ever time out, and it did so against a page that had
 * rendered correctly. Waiting for the shell to be on screen is both the real readiness signal
 * and one that does not depend on the app being idle.
 */
export async function gotoDashboard(page) {
  await page.goto('/dashboard.html');
  await waitForApp(page);
  await page.locator('main').waitFor({ state: 'visible', timeout: 20000 });
}

/** Switch to a dashboard view the way the nav does, once the app is ready to receive it. */
export async function switchView(page, view) {
  await waitForApp(page);
  await page.click(`[data-view="${view}"]`);
}

/**
 * Fail a test if the browser console reported an uncaught error.
 *
 * The dashboard is 20k lines of vanilla JS wired through inline onclick handlers, so a broken
 * handler does not throw anywhere the server can see - it dies silently in the page and the
 * button simply stops working. Watching the console is how that becomes a test failure.
 */
export function collectPageErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

/**
 * Console noise that is not a defect.
 *
 * A 4xx logged by the browser is a server response the application asked for and handles - a
 * rejected form is SUPPOSED to produce one, and failing the test on it would mean asserting that
 * validation never fires. A 5xx is left in: that is the app breaking, not the app working.
 */
const BENIGN = [
  /favicon/i,
  /Failed to load resource.*status of 4\d\d/i,
  /net::ERR_ABORTED/i,
  /service-?worker/i,
  /manifest/i,
];

export function assertNoPageErrors(errors) {
  const real = errors.filter((e) => !BENIGN.some((pattern) => pattern.test(e)));
  expect(real, `the page reported javascript errors:\n${real.join('\n')}`).toEqual([]);
}
