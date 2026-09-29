import { test, expect } from '@playwright/test';
import { login, switchView, collectPageErrors, assertNoPageErrors } from './helpers.js';
import { instance } from './broker.js';

/**
 * The Instances page, on the e2e copy of the operator's real instances (Jz Kotak, Jz Fyers,
 * Jabez Crypto) - never database/simplifyed.db, and never a fake broker.
 *
 * Covers what only a browser can: the form gathers the right fields, the modal closes, the table
 * shows the change, the credential never reaches the page. Nothing here places an order.
 */

test.describe.configure({ mode: 'serial' });

const KOTAK = 'Jz Kotak';
const FYERS = 'Jz Fyers';
const CRYPTO = 'Jabez Crypto';

test.beforeEach(async ({ page }) => {
  await login(page);
  await switchView(page, 'instances');
  await expect(page.locator('.instances-table')).toBeVisible({ timeout: 15000 });
});

const rowOf = (page, name) => page.locator('.instances-table tbody tr', { hasText: name });

async function openEditModal(page, name) {
  await rowOf(page, name).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#edit-instance-form')).toBeVisible({ timeout: 10000 });
}

const saveEdit = async (page) => {
  await page.locator('.modal-overlay').getByRole('button', { name: /update instance/i }).click();
  await expect(page.locator('#edit-instance-form')).toBeHidden({ timeout: 15000 });
};

test('the table lists every instance and never shows an api key', async ({ page }) => {
  for (const name of [KOTAK, FYERS, CRYPTO]) await expect(rowOf(page, name)).toBeVisible();
  const html = await page.content();
  for (const name of [KOTAK, FYERS, CRYPTO]) {
    expect(html.includes((await instance(name)).api_key), `${name}'s api key is on the page`).toBe(false);
  }
});

test('the edit modal opens loaded, with the key masked', async ({ page }) => {
  const kotak = await instance(KOTAK);
  await openEditModal(page, KOTAK);
  await expect(page.locator('#edit-instance-form [name="name"]')).toHaveValue(KOTAK);
  await expect(page.locator('#edit-instance-host-url')).toHaveValue(kotak.host_url);
  const shown = await page.locator('#edit-instance-api-key').inputValue();
  expect(shown).toContain('*');
  expect(shown === kotak.api_key).toBe(false);
});

test('renaming saves, closes the modal and shows in the table; saving untouched keeps the key', async ({ page }) => {
  const errors = collectPageErrors(page);
  const key = (await instance(KOTAK)).api_key;

  await openEditModal(page, KOTAK);
  await page.fill('#edit-instance-form [name="name"]', `${KOTAK} renamed`);
  await saveEdit(page);
  await expect(rowOf(page, `${KOTAK} renamed`)).toBeVisible({ timeout: 10000 });

  await openEditModal(page, `${KOTAK} renamed`);
  await page.fill('#edit-instance-form [name="name"]', KOTAK);
  await saveEdit(page);
  await expect(rowOf(page, KOTAK)).toBeVisible({ timeout: 10000 });

  // The form posts the MASKED key back; writing it would silently break trading.
  expect((await instance(KOTAK)).api_key === key, 'the stored key survived two saves').toBe(true);
  assertNoPageErrors(errors);
});

test('clearing the session target actually clears it', async ({ page }) => {
  const before = (await instance(KOTAK)).session_target_profit;
  test.skip(before == null, 'Jz Kotak has no target to clear');

  await openEditModal(page, KOTAK);
  await page.fill('#edit-instance-form [name="session_target_profit"]', '');
  await saveEdit(page);
  expect((await instance(KOTAK)).session_target_profit).toBeNull();

  await openEditModal(page, KOTAK);
  await page.fill('#edit-instance-form [name="session_target_profit"]', String(before));
  await saveEdit(page);
  expect(Number((await instance(KOTAK)).session_target_profit)).toBe(Number(before));
});

test('a capability switched off stays off, and back on', async ({ page }) => {
  const box = () => page.locator('#edit-instance-form input[name="market_data_enabled"]');
  await openEditModal(page, FYERS);
  await expect(box()).toBeChecked();
  await box().uncheck();
  await saveEdit(page);
  expect((await instance(FYERS)).market_data_enabled).toBe(0);

  await openEditModal(page, FYERS);
  await expect(box()).not.toBeChecked();
  await box().check();
  await saveEdit(page);
  expect((await instance(FYERS)).market_data_enabled).toBe(1);
});

test('a rejected edit is reported and changes nothing', async ({ page }) => {
  const before = (await instance(KOTAK)).multiplier;
  await openEditModal(page, KOTAK);
  await page.fill('#edit-instance-form [name="multiplier"]', '0');
  await page.locator('.modal-overlay').getByRole('button', { name: /update instance/i }).click();
  await expect(page.locator('#toast-container .alert-danger').first()).toBeVisible({ timeout: 10000 });
  expect((await instance(KOTAK)).multiplier).toBe(before);
});

test('the edit modal can be dismissed without saving', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await openEditModal(page, KOTAK);
  await page.fill('#edit-instance-form [name="name"]', 'Should Not Be Saved');
  await page.locator('.modal-overlay').getByRole('button', { name: /cancel/i }).click();
  await page.locator('.modal-overlay button[data-action="confirm"]').click({ timeout: 3000 }).catch(() => {});
  await expect(page.locator('.instances-table')).not.toContainText('Should Not Be Saved');
  expect((await instance(KOTAK)).name).toBe(KOTAK);
});

test('adding an instance with an empty form creates nothing', async ({ page }) => {
  const errors = collectPageErrors(page);
  const rows = await page.locator('.instances-table tbody tr').count();
  await page.getByRole('button', { name: /add instance/i }).first().click();
  await page.locator('.modal-overlay').getByRole('button', { name: /add instance/i }).click();
  await expect(page.locator('#toast-container .alert-danger').first()).toBeVisible({ timeout: 10000 });
  await page.reload();
  await switchView(page, 'instances');
  await expect(page.locator('.instances-table tbody tr')).toHaveCount(rows, { timeout: 10000 });
  assertNoPageErrors(errors);
});

test('an instance can be deleted and added back through the form, broker detected by Test Connection', async ({ page }) => {
  const crypto = await instance(CRYPTO);

  await rowOf(page, CRYPTO).getByRole('button', { name: /delete/i }).click();
  await page.locator('.modal-overlay button[data-action="confirm"]').click();
  await expect(rowOf(page, CRYPTO)).toHaveCount(0, { timeout: 15000 });

  await page.getByRole('button', { name: /add instance/i }).first().click();
  const form = page.locator('#add-instance-form');
  await form.locator('[name="name"]').fill(CRYPTO);
  await page.fill('#instance-host-url', crypto.host_url);
  await page.fill('#instance-api-key', crypto.api_key); // a password field - never rendered
  await form.locator('[name="market_data_enabled"]').check();
  await page.getByRole('button', { name: 'Test Connection' }).click();
  await expect(page.locator('#instance-broker')).toHaveValue(crypto.broker, { timeout: 20000 });
  await page.locator('.modal-overlay').getByRole('button', { name: /add instance/i }).click();
  await expect(rowOf(page, CRYPTO)).toBeVisible({ timeout: 15000 });

  const readded = await instance(CRYPTO);
  expect(readded.api_key === crypto.api_key, 'the key was stored as typed').toBe(true);
  expect(readded.broker).toBe(crypto.broker);
});
