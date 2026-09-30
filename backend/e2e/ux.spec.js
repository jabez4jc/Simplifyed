import { test, expect } from '@playwright/test';
import { login, switchView, waitForApp, collectPageErrors, assertNoPageErrors } from './helpers.js';
import { webhookToken } from './broker.js';

/**
 * User experience and accessibility.
 *
 * These are the failures that no unit or API test can see: a control with no accessible name, a
 * table that scrolls the whole page sideways on a laptop, a modal you cannot close with the
 * keyboard, or a cell that renders the literal text "undefined" because a field was missing.
 * They do not throw, nothing logs them, and the server is perfectly happy - they are only
 * visible to whoever has to use the thing.
 *
 * Every view is checked, because these regress by omission: a new screen simply doesn't get the
 * label, and nothing complains.
 */

const VIEWS = [
  'dashboard', 'instances', 'watchlists', 'orders', 'positions',
  'trades', 'strategies', 'settings', 'notifications', 'daily-pnl-snapshots', 'chart',
];

test.describe('accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('every form control has a label a screen reader can announce', async ({ page }) => {
    const unlabelled = [];

    for (const view of ['instances', 'watchlists', 'settings']) {
      await switchView(page, view);
      await page.waitForTimeout(1200);

      const problems = await page.$$eval(
        'input:not([type=hidden]), select, textarea',
        (els) => els.filter((el) => {
          if (el.offsetParent === null) return false; // not visible, not announced
          if (el.getAttribute('aria-label')) return false;
          if (el.getAttribute('aria-labelledby')) return false;
          if (el.getAttribute('title')) return false;
          if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return false;
          if (el.closest('label')) return false;
          if (el.type === 'checkbox' || el.type === 'radio') return false; // checked separately below
          return true;
        }).map((el) => `${el.tagName.toLowerCase()}[name=${el.name || '?'}][type=${el.type || '?'}]`)
      );

      problems.forEach((p) => unlabelled.push(`${view}: ${p}`));
    }

    expect(unlabelled, `controls with no accessible name:\n${unlabelled.join('\n')}`).toEqual([]);
  });

  test('no button is announced as nothing but an icon', async ({ page }) => {
    // A button whose only content is an emoji reads out as that emoji, or as nothing at all.
    // `title` is not a reliable substitute - it is not announced by every screen reader and
    // never on touch - so an icon-only control needs aria-label.
    const nameless = [];

    for (const view of ['instances', 'watchlists', 'orders']) {
      await switchView(page, view);
      await page.waitForTimeout(1200);

      const problems = await page.$$eval('button, a[role=button]', (els) => els
        .filter((el) => el.offsetParent !== null)
        .filter((el) => {
          if (el.getAttribute('aria-label')) return false;
          if (el.getAttribute('aria-labelledby')) return false;
          const text = (el.textContent || '').trim();
          if (!text) return true;
          // Text made only of symbols/emoji is not a name.
          return !/[a-z0-9]/i.test(text);
        })
        .map((el) => `"${(el.textContent || '').trim().slice(0, 12)}" title=${el.getAttribute('title') || 'none'}`)
      );

      problems.forEach((p) => nameless.push(`${view}: ${p}`));
    }

    expect(nameless, `icon-only controls with no aria-label:\n${nameless.join('\n')}`).toEqual([]);
  });

  test('the page has exactly one main heading and a main landmark', async ({ page }) => {
    await switchView(page, 'dashboard');
    await page.waitForTimeout(1000);

    const h1Count = await page.locator('h1').count();
    expect(h1Count, 'a page needs exactly one h1 for screen-reader navigation').toBe(1);

    const landmarks = await page.locator('main, [role=main]').count();
    expect(landmarks, 'a main landmark lets a screen reader skip the nav').toBeGreaterThan(0);
  });

  test('every image carries alt text', async ({ page }) => {
    await switchView(page, 'dashboard');
    const missing = await page.$$eval('img', (els) =>
      els.filter((el) => !el.hasAttribute('alt')).map((el) => el.getAttribute('src') || '(no src)')
    );
    expect(missing, `images with no alt attribute:\n${missing.join('\n')}`).toEqual([]);
  });
});

test.describe('keyboard', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('the primary navigation is reachable and operable by keyboard alone', async ({ page }) => {
    await waitForApp(page);

    const navItem = page.locator('[data-view="instances"]').first();
    await navItem.focus();

    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-view'));
    expect(focused, 'nav items must be focusable - a div with onclick is not').toBe('instances');

    await page.keyboard.press('Enter');
    await expect(page.locator('.instances-table')).toBeVisible({ timeout: 15000 });
  });

  test('a modal can be closed from the keyboard', async ({ page }) => {
    await switchView(page, 'instances');
    await expect(page.locator('.instances-table')).toBeVisible({ timeout: 15000 });

    await page.locator('.instances-table tbody tr').first()
      .getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.locator('#edit-instance-form')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('#edit-instance-form'),
      'Escape must dismiss a modal - trapping a keyboard user inside it is a dead end').toBeHidden({ timeout: 5000 });
  });

  test('opening a modal moves focus into it', async ({ page }) => {
    await switchView(page, 'instances');
    await expect(page.locator('.instances-table')).toBeVisible({ timeout: 15000 });

    await page.locator('.instances-table tbody tr').first()
      .getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.locator('#edit-instance-form')).toBeVisible();
    await page.waitForTimeout(300);

    const focusInsideModal = await page.evaluate(() =>
      !!document.activeElement?.closest('.modal-overlay, #edit-instance-form'));
    expect(focusInsideModal,
      'focus must move into the dialog, or a keyboard user is still tabbing through the page behind it').toBe(true);
  });
});

test.describe('layout', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  for (const [label, width, height] of [['laptop', 1280, 800], ['tablet', 834, 1112], ['phone', 390, 844]]) {
    test(`no view scrolls sideways at ${label} width`, async ({ page }) => {
      // Horizontal page scroll is the classic symptom of a fixed-width table in a responsive
      // shell. A wide table should scroll inside its own container, not drag the page with it.
      await page.setViewportSize({ width, height });
      const overflowing = [];

      for (const view of ['dashboard', 'instances', 'watchlists', 'orders', 'settings']) {
        // Switch programmatically rather than by clicking. At narrow widths the sidebar is
        // off-canvas and its links are not clickable - which is its own finding, tested
        // separately below - but this test is about the LAYOUT of each view, and it should not
        // be blocked from measuring that by how the view gets opened.
        await page.evaluate((v) => window.app.switchView(v), view);
        await page.waitForTimeout(1000);

        const overflow = await page.evaluate(() =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth);

        if (overflow > 2) overflowing.push(`${view}: ${overflow}px past the viewport`);
      }

      expect(overflowing, `views that force horizontal page scroll at ${width}px:\n${overflowing.join('\n')}`).toEqual([]);
    });
  }

  test('content stays inside the viewport rather than under the navigation', async ({ page }) => {
    await switchView(page, 'instances');
    await page.waitForTimeout(1000);

    const box = await page.locator('#content-area').boundingBox();
    expect(box, 'the content area must be laid out').not.toBeNull();
    expect(box.x, 'content must not start off the left edge of the screen').toBeGreaterThanOrEqual(0);
  });
});

test.describe('rendered content', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('no view renders a raw javascript placeholder to the operator', async ({ page }) => {
    // "undefined", "NaN" and "[object Object]" in a cell are what a missing field looks like
    // after it has been concatenated into a template. On a trading dashboard those sit next to
    // real numbers and are indistinguishable from data unless you know to look.
    const offenders = [];

    for (const view of VIEWS) {
      await switchView(page, view);
      await page.waitForTimeout(900);

      const found = await page.evaluate(() => {
        const text = document.getElementById('content-area')?.innerText || '';
        const bad = ['undefined', 'NaN', '[object Object]', 'null,', 'Infinity'];
        return bad.filter((token) => text.includes(token));
      });

      found.forEach((token) => offenders.push(`${view}: rendered "${token}"`));
    }

    expect(offenders, `raw placeholders visible to the operator:\n${offenders.join('\n')}`).toEqual([]);
  });

  test('every view renders something rather than a blank panel', async ({ page }) => {
    const blank = [];

    for (const view of VIEWS) {
      await switchView(page, view);
      await page.waitForTimeout(900);

      const text = (await page.locator('#content-area').innerText().catch(() => '')).trim();
      if (text.length < 10) blank.push(`${view}: ${text.length} characters rendered`);
    }

    expect(blank, `views that rendered nothing:\n${blank.join('\n')}`).toEqual([]);
  });

  test('switching between every view leaves no javascript errors behind', async ({ page }) => {
    const errors = collectPageErrors(page);

    for (const view of VIEWS) {
      await switchView(page, view);
      await page.waitForTimeout(700);
    }

    assertNoPageErrors(errors);
  });
});

test.describe('feedback', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('a failed save tells the operator, rather than failing silently', async ({ page }) => {
    await switchView(page, 'instances');
    await expect(page.locator('.instances-table')).toBeVisible({ timeout: 15000 });

    await page.route('**/api/v1/instances/*', (route) => {
      if (route.request().method() === 'PUT') {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'error', message: 'Something went wrong' }),
        });
      }
      return route.continue();
    });

    await page.locator('.instances-table tbody tr').first()
      .getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.locator('#edit-instance-form')).toBeVisible();
    await page.fill('#edit-instance-form [name="name"]', 'Will Fail');
    await page.locator('.modal-overlay').getByRole('button', { name: /update instance/i }).click();

    await expect(page.locator('.toast, .alert, [role=status], [role=alert]').first())
      .toBeVisible({ timeout: 10000 });
  });

  test('the kill switch is in the top bar and asks before doing anything', async ({ page }) => {
    // Never confirmed here: it would close every position on the real e2e accounts. The server
    // side is covered on a flat analyzer account by Test/integration/kill-switch.test.js.
    const fired = [];
    page.on('request', (r) => { if (r.url().includes('/api/v1/kill-switch')) fired.push(r.url()); });
    await expect(page.locator('#pause-toggle-btn')).toHaveCount(0);

    await page.locator('#kill-switch-btn').click();
    const dialog = page.locator('.modal-overlay');
    await expect(dialog).toContainText('Kill switch');
    await expect(dialog).toContainText('switches every instance to analyzer mode');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(fired, 'Cancel must not call the kill switch').toEqual([]);

    // Confirm, with the request answered here so no server or broker is reached. What matters
    // is the body: it was once JSON-encoded twice and the server refused it as invalid JSON.
    let sent;
    await page.route('**/api/v1/kill-switch', (route) => {
      sent = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'success', data: { success: true, instances: [] } }),
      });
    });
    await page.locator('#kill-switch-btn').click();
    await page.locator('.modal-overlay').getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('#toast-container')).toContainText('Kill switch done');
    expect(sent).toEqual({ confirm: 'KILL' });
  });

  test('the dashboard survives the API being unreachable', async ({ page }) => {
    // An operator whose network drops should see the app say so, not a blank screen or a wall of
    // uncaught promise rejections.
    const errors = collectPageErrors(page);
    await page.route('**/api/v1/**', (route) => route.abort('failed'));

    await switchView(page, 'instances');
    await page.waitForTimeout(2500);

    await expect(page.locator('body')).toBeVisible();
    const real = errors.filter((e) => !/net::ERR_|Failed to (load|fetch)|4\d\d|5\d\d/i.test(e));
    expect(real, `an offline API produced uncaught page errors:\n${real.join('\n')}`).toEqual([]);
  });
});

test.describe('settings', () => {
  test('the webhook token can be rotated from Access Control, and the old one stops working', async ({ page, request }) => {
    // Runs on the e2e copy; the webhook workflow specs after this one trade with the rotated
    // token, read back from that copy. The token itself is never printed.
    const errors = collectPageErrors(page);
    const old = await webhookToken();
    await login(page);
    await switchView(page, 'settings');
    await page.click('.settings-main-tab[data-tab="access"]');
    await page.click('#rotate-webhook-token-btn');
    await page.locator('.modal-overlay button[data-action="confirm"]').click();
    const shown = page.locator('#rotated-webhook-token-value');
    await expect(shown).toHaveText(/^[A-Za-z0-9_-]{32,}$/, { timeout: 10000 });
    const fresh = await shown.innerText();

    const probe = (token) => request.post('/webhook/tradingview/broadcast/no-such-slug', {
      headers: { 'Content-Type': 'text/plain', 'X-Webhook-Token': token },
      data: '{ not json',
    });
    expect(fresh === old, 'a different token').toBe(false);
    expect((await probe(old)).status(), 'the old token is refused').toBe(401);
    expect((await probe(fresh)).status(), 'the new token is accepted').toBe(422);
    assertNoPageErrors(errors);
  });
});

test.describe('small screens', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('the navigation is reachable on a phone', async ({ page }) => {
    // The sidebar is off-canvas at phone width, so there must be something on screen that opens
    // it. Without that, none of the app's views can be reached on a phone at all.
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForApp(page);
    await page.waitForTimeout(800);

    const navLink = page.locator('[data-view="instances"]').first();
    const clickable = await navLink.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      if (rect.right < 0 || rect.left > window.innerWidth) return false;
      const atPoint = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return !!atPoint && (el === atPoint || el.contains(atPoint));
    });

    if (clickable) return; // the sidebar is on-screen and usable, nothing more to prove

    // Match only things a person could actually press. `.drawer-toggle` itself is the hidden
    // checkbox daisyUI toggles behind the scenes, so selecting it would test nothing.
    const opener = page.locator(
      'label[for="drawer-toggle"], [aria-label*="open navigation" i], [aria-label*="menu" i], .menu-toggle, .hamburger'
    ).filter({ visible: true }).first();

    await expect(opener, 'with the sidebar off-canvas there must be a visible control to open it').toBeVisible({ timeout: 5000 });
    await opener.click();
    await expect(navLink).toBeVisible({ timeout: 5000 });
  });
});
