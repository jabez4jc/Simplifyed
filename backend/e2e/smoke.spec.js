import { test, expect } from '@playwright/test';
import { login, collectPageErrors, assertNoPageErrors, ADMIN } from './helpers.js';

/**
 * Does the application actually come up and let a real operator in.
 *
 * Everything else in e2e/ assumes this passes, so it is deliberately the least clever file here.
 */

test('the login page loads and rejects a wrong password without letting anyone in', async ({ page }) => {
  await page.goto('/login.html');
  await expect(page.locator('#login-email')).toBeVisible();

  await page.fill('#login-email', ADMIN.email);
  await page.fill('#login-password', 'definitely-not-the-password');
  await page.click('#login-btn');

  await expect(page.locator('#message-area')).toContainText(/invalid|incorrect|error/i, { timeout: 10000 });
  const token = await page.evaluate(() => localStorage.getItem('auth_token'));
  expect(token, 'a failed login must not store a token').toBeNull();
});

test('a correct password gets an operator to the dashboard', async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL(/dashboard\.html/);
});

test('the dashboard renders without javascript errors', async ({ page }) => {
  const errors = collectPageErrors(page);
  // login() lands on the dashboard. Navigating to it again would abort the first page's
  // requests mid-flight, and the aborted fetch logs as an error that has nothing to do with the app.
  await login(page);
  await expect(page.locator('main')).toBeVisible();
  await expect(page.locator('#content-area')).not.toBeEmpty({ timeout: 15000 });
  await page.waitForTimeout(2000); // let the view's first round of requests settle
  assertNoPageErrors(errors);
});

test('an unauthenticated visitor cannot reach the dashboard', async ({ page }) => {
  // Clear storage from a page that is already on the origin, BEFORE asking for the dashboard -
  // clearing it mid-navigation races the redirect the test is trying to observe.
  await page.goto('/login.html');
  await page.evaluate(() => localStorage.clear());

  await page.goto('/dashboard.html');
  await expect(page).toHaveURL(/login\.html/, { timeout: 15000 });
});

test('a discarded token sends the operator back to the login form', async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL(/dashboard\.html/);

  await page.evaluate(() => localStorage.removeItem('auth_token'));
  // The page redirects while it loads, so wait only for the response, not the load event. The
  // dashboard already open may notice the missing token first and redirect on its own, which
  // aborts this navigation - either way the operator must end up on the login form, below.
  await page.goto('/dashboard.html', { waitUntil: 'commit' }).catch((error) => {
    if (!/ERR_ABORTED/.test(String(error))) throw error;
  });

  await expect(page).toHaveURL(/login\.html/, { timeout: 15000 });
});
