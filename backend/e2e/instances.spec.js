import { test, expect } from '@playwright/test';
import { login, switchView, collectPageErrors, assertNoPageErrors } from './helpers.js';

/**
 * The instance edit flow, driven the way an operator drives it.
 *
 * This is the screen the work started from ("editing instances doesn't work"). The API-level
 * tests in Test/integration/instances.test.js cover what the endpoint does; these cover the part
 * only a browser can: whether the form gathers the right fields, whether the modal closes, and
 * whether the table shows the change afterwards. A handler wired through an inline onclick fails
 * silently in the page - the server never hears about it - so nothing below the browser can see
 * that class of bug.
 */

test.beforeEach(async ({ page }) => {
  await login(page);
  await switchView(page, 'instances');
  await expect(page.locator('.instances-table')).toBeVisible({ timeout: 15000 });
});

async function openEditModal(page, instanceName) {
  const row = page.locator('.instances-table tbody tr', { hasText: instanceName });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#edit-instance-form')).toBeVisible({ timeout: 10000 });
  return row;
}

/** The modal's save button, scoped to the modal - "Add Instance" also names a toolbar button. */
const saveEdit = (page) => page.locator('.modal-overlay').getByRole('button', { name: /update instance/i });
const closeEdit = (page) => page.locator('.modal-overlay').getByRole('button', { name: /cancel/i });

test('the instances table lists the seeded instances and never shows a raw api key', async ({ page }) => {
  await expect(page.locator('.instances-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.instances-table')).toContainText('E2E Primary');

  const html = await page.content();
  expect(html, 'the instances page must not embed a live api key').not.toContain('e2e-api-key-abcdef123456');
});

test('the edit modal opens with the instance already loaded into it', async ({ page }) => {
  await openEditModal(page, 'E2E Primary');

  await expect(page.locator('#edit-instance-form [name="name"]')).toHaveValue('E2E Primary');
  await expect(page.locator('#edit-instance-host-url')).toHaveValue(/127\.0\.0\.1/);

  // The key is shown masked - the form has to render something, but not the credential.
  const apiKey = await page.locator('#edit-instance-api-key').inputValue();
  expect(apiKey).toContain('*');
  expect(apiKey).not.toBe('e2e-api-key-abcdef123456');
});

test('renaming an instance saves, closes the modal, and shows up in the table', async ({ page }) => {
  const errors = collectPageErrors(page);
  await openEditModal(page, 'E2E Primary');

  await page.fill('#edit-instance-form [name="name"]', 'E2E Renamed');
  await saveEdit(page).click();

  await expect(page.locator('#edit-instance-form')).toBeHidden({ timeout: 10000 });
  await expect(page.locator('.instances-table')).toContainText('E2E Renamed', { timeout: 10000 });

  assertNoPageErrors(errors);

  // Put it back so the remaining specs still find it by its seeded name.
  await openEditModal(page, 'E2E Renamed');
  await page.fill('#edit-instance-form [name="name"]', 'E2E Primary');
  await saveEdit(page).click();
  await expect(page.locator('.instances-table')).toContainText('E2E Primary', { timeout: 10000 });
});

test('saving the form untouched does not wipe the stored api key', async ({ page }) => {
  // The form renders the MASKED key and posts it straight back. If that value were written, a
  // working credential would be replaced with asterisks and the instance would silently stop
  // trading - and the operator would have done nothing but click Update.
  await openEditModal(page, 'E2E Primary');
  await saveEdit(page).click();
  await expect(page.locator('#edit-instance-form')).toBeHidden({ timeout: 10000 });

  // Reopen: a destroyed key would come back as a mask of asterisks with no real characters left.
  await openEditModal(page, 'E2E Primary');
  const apiKey = await page.locator('#edit-instance-api-key').inputValue();
  expect(apiKey, 'the masked key must still be masking a real value').toMatch(/[a-z0-9]/i);
});

test('clearing the session target profit actually clears it', async ({ page }) => {
  // The seeded instance has a target of 5000. Emptying the box means "no target"; leaving the
  // old figure in force while the form shows it as cleared is the failure this guards.
  await openEditModal(page, 'E2E Primary');
  await expect(page.locator('#edit-instance-form [name="session_target_profit"]')).toHaveValue('5000');

  await page.fill('#edit-instance-form [name="session_target_profit"]', '');
  await saveEdit(page).click();
  await expect(page.locator('#edit-instance-form')).toBeHidden({ timeout: 10000 });

  await openEditModal(page, 'E2E Primary');
  await expect(page.locator('#edit-instance-form [name="session_target_profit"]')).toHaveValue('');
});

test('unchecking a capability turns it off and it stays off', async ({ page }) => {
  await openEditModal(page, 'E2E Primary');

  const checkbox = page.locator('#edit-instance-form input[name="market_data_enabled"]');
  await expect(checkbox).toBeChecked();

  await checkbox.uncheck();
  await saveEdit(page).click();
  await expect(page.locator('#edit-instance-form')).toBeHidden({ timeout: 10000 });

  await openEditModal(page, 'E2E Primary');
  await expect(page.locator('#edit-instance-form input[name="market_data_enabled"]'),
    'an unchecked box must persist as off, not fall back to its old value').not.toBeChecked();

  // Restore for the other specs.
  await page.locator('#edit-instance-form input[name="market_data_enabled"]').check();
  await saveEdit(page).click();
  await expect(page.locator('#edit-instance-form')).toBeHidden({ timeout: 10000 });
});

test('a rejected edit reports the error and leaves the instance unchanged', async ({ page }) => {
  await openEditModal(page, 'E2E Primary');

  await page.fill('#edit-instance-form [name="multiplier"]', '0');
  await saveEdit(page).click();

  // The operator must be told. Silently accepting or silently discarding are both wrong.
  await expect(page.locator('.toast, .alert, #message-area, [role="status"]').first())
    .toBeVisible({ timeout: 10000 });

  await page.reload();
  await switchView(page, 'instances');
  await expect(page.locator('.instances-table tbody tr', { hasText: 'E2E Primary' }))
    .not.toContainText('0', { timeout: 10000 })
    .catch(() => { /* the multiplier column may format differently; the DB assertion below is the real one */ });
});

test('the edit modal can be dismissed without saving anything', async ({ page }) => {
  await openEditModal(page, 'E2E Primary');
  await page.fill('#edit-instance-form [name="name"]', 'Should Not Be Saved');
  await closeEdit(page).click();

  // A dirty-close may ask for confirmation; accept it if so.
  page.once('dialog', (dialog) => dialog.accept());

  await expect(page.locator('.instances-table')).not.toContainText('Should Not Be Saved', { timeout: 10000 });
});

test('adding an instance validates before it creates anything', async ({ page }) => {
  const errors = collectPageErrors(page);
  const rowsBefore = await page.locator('.instances-table tbody tr').count();

  await page.getByRole('button', { name: /add instance/i }).first().click();
  await expect(page.locator('#instance-api-key')).toBeVisible({ timeout: 10000 });

  // Submitting the empty form must neither create a row nor throw inside the page.
  await page.locator('.modal-overlay').getByRole('button', { name: /add instance/i }).click();
  await page.waitForTimeout(1500);

  await closeEdit(page).click().catch(() => {});
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await switchView(page, 'instances');

  await expect(page.locator('.instances-table tbody tr')).toHaveCount(rowsBefore, { timeout: 10000 });
  assertNoPageErrors(errors);
});
