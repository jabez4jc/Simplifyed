import { test, expect } from '@playwright/test';
import { login, switchView, collectPageErrors, assertNoPageErrors } from './helpers.js';
import { assertAnalyzer, instance, netPosition, waitForNet, flatten, webhookToken } from './broker.js';

/**
 * Every step of a strategy, on the operator's real brokers (analyzer mode), through the
 * Strategies page: create it, scope it to an instance, add a leg with a target and stop in
 * percent, execute, exit, drive the same strategy from a TradingView webhook, and delete it.
 *
 * Crypto (Jabez Crypto, BTC futures) trades 24x7 so every step always runs. Everything ordered
 * is flattened in afterAll and the run fails if anything is left open.
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(180000);

const CRYPTO = 'Jabez Crypto';
const STAMP = new Date().toISOString().slice(11, 19);
const ordered = [];

let page;
let errors;

const row = (name) => page.locator('.strategy-row-wrapper', { hasText: name });

async function createStrategy(name, { trigger = 'MANUAL' } = {}) {
  await switchView(page, 'strategies');
  await page.getByRole('button', { name: '+ New Strategy' }).first().click();
  await page.fill('#strategy-name-input', name);
  await page.fill('#strategy-underlying-input', 'BTC');
  await page.selectOption('#strategy-exchange-select', 'CRYPTO');
  await page.selectOption('#strategy-trigger-input', trigger);
  await page.locator('.modal-overlay').getByRole('button', { name: 'Create' }).click();
  await expect(row(name)).toBeVisible({ timeout: 15000 });

  // Scope it to the crypto account only.
  await row(name).locator('[title*="instances"]').click();
  const crypto = await instance(CRYPTO);
  await expect(page.locator('.strategy-instance-checkbox').first()).toBeVisible();
  for (const box of await page.locator('.strategy-instance-checkbox').all()) {
    const id = await box.getAttribute('data-instance-id');
    if (id === String(crypto.id)) await box.check(); else await box.uncheck();
  }
  await page.locator('.modal-overlay').getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.modal-overlay')).toHaveCount(0, { timeout: 10000 });
}

async function addFuturesLeg(name, fields = {}) {
  await row(name).locator('[title="Add Leg"]').click();
  await page.selectOption('#leg-action-input', 'BUY');
  await page.selectOption('#leg-option-type-input', '');
  await page.selectOption('#leg-product-type-input', 'NRML');
  for (const [id, value] of Object.entries(fields)) {
    const el = page.locator(`#${id}`);
    if ((await el.evaluate((e) => e.tagName)) === 'SELECT') await el.selectOption(value);
    else await el.fill(value);
  }
  await page.locator('.modal-overlay').getByRole('button', { name: 'Add Leg' }).click();
  await expect(page.locator('.modal-overlay')).toHaveCount(0, { timeout: 10000 });
  await expect(row(name)).toContainText('1 leg(s)', { timeout: 10000 });
}

test.beforeAll(async ({ browser }) => {
  await assertAnalyzer(CRYPTO);
  page = await browser.newPage();
  page.on('dialog', (d) => d.accept());
  errors = collectPageErrors(page);
  await login(page);
});

test.afterAll(async () => {
  const leftovers = await flatten(ordered);
  await page?.close();
  expect(leftovers, `left open at the broker:\n${leftovers.join('\n')}`).toEqual([]);
});

const MANUAL = `E2E BTC ${STAMP}`;

test('create a strategy, scope it to one instance, and add a leg with a % target and stop', async () => {
  await createStrategy(MANUAL);
  await expect(row(MANUAL)).toContainText('CRYPTO:BTC');
  // Far away on purpose, so the running auto-exit leaves this test's position alone.
  await addFuturesLeg(MANUAL, { 'leg-exit-unit-input': 'PERCENT', 'leg-target-input': '40', 'leg-stoploss-input': '30' });

  // The leg keeps its unit and values when reopened.
  // Adding a leg opens the leg list, so the new leg is right there to edit.
  await row(MANUAL).locator('[title="Edit Leg"]').first().click();
  await expect(page.locator('#leg-exit-unit-input')).toHaveValue('PERCENT');
  await expect(page.locator('#leg-target-input')).toHaveValue('40');
  await expect(page.locator('#leg-stoploss-input')).toHaveValue('30');
  await page.locator('.modal-overlay').getByRole('button', { name: 'Cancel' }).click();
});

test('Execute places the leg at the broker; Exit All closes it', async () => {
  ordered.push({ name: CRYPTO, symbol: 'BTCUSDFUT', exchange: 'CRYPTO' });
  const before = await netPosition(CRYPTO, 'BTCUSDFUT');

  await row(MANUAL).getByRole('button', { name: 'Execute' }).click();
  await expect(page.locator('.modal-overlay')).toContainText(CRYPTO);
  const executed = page.waitForResponse((r) => /\/strategies\/\d+\/execute$/.test(r.url()), { timeout: 60000 });
  await page.locator('.modal-overlay').getByRole('button', { name: /execute on all/i }).click();
  const exec = await (await executed).json();
  const legs = exec.data.instances.flatMap((i) => i.legs);
  expect(legs.map((l) => [l.success, l.resolvedSymbol]), JSON.stringify(exec).slice(0, 600)).toEqual([[true, 'BTCUSDFUT']]);
  expect(await waitForNet(CRYPTO, 'BTCUSDFUT', before + 1)).toBe(before + 1);

  await row(MANUAL).getByRole('button', { name: 'Exit All' }).click();
  const exited = page.waitForResponse((r) => /\/strategies\/\d+\/exit$/.test(r.url()), { timeout: 60000 });
  await page.locator('.modal-overlay').getByRole('button', { name: 'Exit All Legs' }).click();
  const exit = await (await exited).json();
  expect(exit.data.success, JSON.stringify(exit).slice(0, 600)).toBe(true);
  expect(await waitForNet(CRYPTO, 'BTCUSDFUT', before)).toBe(before);
});

const WEBHOOK = `E2E BTC webhook ${STAMP}`;

test('a webhook strategy enters on a TradingView alert and exits on an EXIT alert', async ({ request }) => {
  await createStrategy(WEBHOOK, { trigger: 'WEBHOOK' });
  await addFuturesLeg(WEBHOOK);

  // The webhook URL is on the strategy's edit screen, where the operator copies it from. Only
  // the slug is kept - the page may show the token too, and it must never be printed.
  await row(WEBHOOK).locator('[title="Edit"]').click();
  await expect(page.locator('.modal-overlay code.code-inline').first()).toBeVisible();
  const shown = await page.locator('.modal-overlay code.code-inline').allInnerTexts();
  const slug = shown.map((t) => (t.match(/broadcast\/([A-Za-z0-9_-]+)/) || [])[1]).find(Boolean);
  expect(Boolean(slug), 'the strategy shows its webhook URL').toBe(true);
  await page.locator('.modal-overlay').getByRole('button', { name: 'Cancel' }).click();

  ordered.push({ name: CRYPTO, symbol: 'BTCUSDFUT', exchange: 'CRYPTO' });
  const before = await netPosition(CRYPTO, 'BTCUSDFUT');
  const token = await webhookToken();
  const alert = (body) => request.post(`/webhook/tradingview/broadcast/${slug}`, {
    headers: { 'Content-Type': 'text/plain', 'X-Webhook-Token': token },
    data: JSON.stringify(body),
  });

  const entry = await alert({ action: 'ENTRY' });
  const entryBody = await entry.text();
  expect(entry.status(), entryBody.slice(0, 600)).toBe(200);
  const entryLegs = JSON.parse(entryBody).data.instances.flatMap((i) => i.legs);
  expect(entryLegs.map((l) => [l.success, l.resolvedSymbol]), entryBody.slice(0, 600)).toEqual([[true, 'BTCUSDFUT']]);
  expect(await waitForNet(CRYPTO, 'BTCUSDFUT', before + 1)).toBe(before + 1);

  const exit = await alert({ action: 'EXIT_ALL' }); // the payload the edit screen documents
  expect(exit.status(), (await exit.text()).slice(0, 600)).toBe(200);
  expect(await waitForNet(CRYPTO, 'BTCUSDFUT', before)).toBe(before);
});

test('strategies can be deleted, and nothing on the page broke along the way', async () => {
  await switchView(page, 'strategies');
  for (const name of [MANUAL, WEBHOOK]) {
    await row(name).locator('[title="Delete"]').click();
    const confirm = page.locator('.modal-overlay button[data-action="confirm"]');
    await confirm.click({ timeout: 3000 }).catch(() => { /* native confirm() - accepted by the dialog handler */ });
    await expect(row(name)).toHaveCount(0, { timeout: 15000 });
  }
  assertNoPageErrors(errors);
});
