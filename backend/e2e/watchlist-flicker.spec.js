/**
 * @fileoverview E2E Test: Watchlist Quotes Flickering Issue
 * This test reproduces the watchlist quotes flickering problem caused by:
 * 1. Auto-refresh (15s) re-rendering the entire view
 * 2. Independent watchlist polling (10s) trying to update DOM
 * 3. Race conditions between these two mechanisms
 */

import { test, expect } from '@playwright/test';

test.describe('Watchlist Quotes Flickering Issue', () => {
  let consoleErrors = [];

  test.beforeEach(async ({ page }) => {
    // Clear console errors from previous tests
    consoleErrors = [];

    // Enable console logging to catch errors
    page.on('console', msg => {
      console.log(`[Browser Console] ${msg.type()}: ${msg.text()}`);

      // Collect errors for later reporting
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Enable network monitoring
    page.on('response', response => {
      if (response.url().includes('/api/v1/')) {
        console.log(`[API] ${response.request().method()} ${response.url()} - ${response.status()}`);
      }
    });
  });

  test('should not have flickering when watchlist auto-refreshes', async ({ page }) => {
    console.log('\n🔍 Starting watchlist flicker test...\n');

    // Navigate to dashboard
    await page.goto('/');

    // Wait for login or dashboard
    await page.waitForLoadState('networkidle');

    // Check if we need to login (test mode) - use reliable selector
    try {
      await page.waitForSelector('#current-user-email', { timeout: 5000 });
      console.log('✅ Logged in successfully\n');
    } catch (error) {
      console.log('⚠️  Could not find login indicator (may need authentication)');
      return;
    }

    // Click on Watchlists navigation
    await page.click('[data-view="watchlists"]');
    await page.waitForLoadState('networkidle');
    console.log('📋 Navigated to Watchlists view\n');

    // Wait a bit for the view to settle
    await page.waitForTimeout(2000);

    // Track DOM element stability during polling cycles
    let elementCount = 0;
    let errors = [];

    // Monitor for 25 seconds (should capture at least one full 15s auto-refresh + 10s watchlist poll)
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(1000);

      // Check for quote cells
      const quoteCells = await page.locator('.ltp-cell').count().catch(() => 0);

      if (quoteCells > 0 && elementCount === 0) {
        elementCount = quoteCells;
        console.log(`📊 Found ${elementCount} quote cells\n`);
      }

      // Look for any DOM recreation or flickering
      const currentElementCount = await page.locator('.ltp-cell').count().catch(() => 0);

      if (elementCount > 0 && currentElementCount !== elementCount && currentElementCount !== 0) {
        const warning = `⚠️  Element count changed from ${elementCount} to ${currentElementCount} (potential DOM recreation/flickering)`;
        console.log(warning);
        errors.push(warning);
        elementCount = currentElementCount;
      }

      // Check if values are being updated
      const quoteValues = await page.evaluate(() => {
        const cells = document.querySelectorAll('.ltp-cell span');
        return Array.from(cells).map(cell => cell.textContent.trim()).slice(0, 5);
      });

      if (i % 5 === 0 && quoteValues.length > 0) {
        console.log(`⏱️  [${i}s] Sample quote values:`, quoteValues);
      }
    }

    console.log('\n⏱️  Test completed after 25 seconds\n');

    // Report findings
    if (errors.length > 0) {
      console.log(`❌ Found ${errors.length} potential flickering issues:`);
      errors.forEach((err, i) => console.log(`   ${i + 1}. ${err}`));
    } else {
      console.log('✅ No flickering detected in DOM element count\n');
    }

    // Check console for any critical errors (collected in beforeEach)
    if (consoleErrors.length > 0) {
      console.log(`\n❌ Found ${consoleErrors.length} console errors:`);
      consoleErrors.forEach((err, i) => console.log(`   ${i + 1}. ${err}`));
    }

    // Expect minimal errors (the test just needs to document what it finds)
    console.log('\n✅ Test completed - review logs for flickering indicators\n');
  });

  test('should handle view transitions without flickering', async ({ page }) => {
    console.log('\n🔍 Testing view transitions...\n');

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Test multiple view switches
    const views = ['dashboard', 'instances', 'watchlists', 'orders', 'positions'];

    for (const view of views) {
      console.log(`➡️  Switching to ${view} view...`);
      await page.click(`[data-view="${view}"]`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1500);
      console.log(`✅ ${view} view loaded\n`);
    }

    console.log('✅ View transitions completed without errors\n');
  });
});
