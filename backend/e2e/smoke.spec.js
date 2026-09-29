import { test, expect } from '@playwright/test';
import { login, gotoDashboard, collectPageErrors, assertNoPageErrors, ADMIN } from './helpers.js';

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
  await login(page);
  await gotoDashboard(page);

  await expect(page.locator('body')).toBeVisible();
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
  await page.goto('/dashboard.html');

  await expect(page).toHaveURL(/login\.html/, { timeout: 15000 });
});
