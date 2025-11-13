/**
 * Expiry Management Service - Unit Tests
 * Tests expiry classification, refresh logic, and scheduling
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import expiryManagementService from '../../../src/services/expiry-management.service.js';

describe('Expiry Management Service', () => {
  describe('_isWeeklyExpiry', () => {
    it('should identify Thursday as weekly expiry', () => {
      // Thursday, Nov 13, 2025 (using explicit date parts to avoid timezone issues)
      const thursday = new Date(2025, 10, 13); // Month is 0-indexed (10 = November)

      const isWeekly = expiryManagementService._isWeeklyExpiry(thursday);

      assert.equal(isWeekly, true);
    });

    it('should not identify Friday as weekly expiry', () => {
      // Friday, Nov 14, 2025
      const friday = new Date(2025, 10, 14);

      const isWeekly = expiryManagementService._isWeeklyExpiry(friday);

      assert.equal(isWeekly, false);
    });

    it('should not identify Monday as weekly expiry', () => {
      // Monday, Nov 10, 2025
      const monday = new Date(2025, 10, 10);

      const isWeekly = expiryManagementService._isWeeklyExpiry(monday);

      assert.equal(isWeekly, false);
    });
  });

  describe('_isMonthlyExpiry', () => {
    it('should identify last Thursday of month as monthly expiry', () => {
      // Last Thursday of November 2025 (Nov 27)
      const lastThursday = new Date(2025, 10, 27);

      const isMonthly = expiryManagementService._isMonthlyExpiry(lastThursday);

      assert.equal(isMonthly, true);
    });

    it('should not identify first Thursday as monthly expiry', () => {
      // First Thursday of November 2025 (Nov 6)
      const firstThursday = new Date(2025, 10, 6);

      const isMonthly = expiryManagementService._isMonthlyExpiry(firstThursday);

      assert.equal(isMonthly, false);
    });

    it('should not identify non-Thursday as monthly expiry', () => {
      // Last Friday of November 2025 (Nov 28)
      const lastFriday = new Date(2025, 10, 28);

      const isMonthly = expiryManagementService._isMonthlyExpiry(lastFriday);

      assert.equal(isMonthly, false);
    });
  });

  describe('_isQuarterlyExpiry', () => {
    it('should identify last Thursday of March as quarterly', () => {
      // Last Thursday of March 2025 (Mar 27)
      const marchExpiry = new Date(2025, 2, 27); // Month 2 = March

      const isQuarterly = expiryManagementService._isQuarterlyExpiry(marchExpiry);

      assert.equal(isQuarterly, true);
    });

    it('should identify last Thursday of June as quarterly', () => {
      // Last Thursday of June 2025 (Jun 26)
      const juneExpiry = new Date(2025, 5, 26); // Month 5 = June

      const isQuarterly = expiryManagementService._isQuarterlyExpiry(juneExpiry);

      assert.equal(isQuarterly, true);
    });

    it('should identify last Thursday of September as quarterly', () => {
      // Last Thursday of September 2025 (Sep 25)
      const sepExpiry = new Date(2025, 8, 25); // Month 8 = September

      const isQuarterly = expiryManagementService._isQuarterlyExpiry(sepExpiry);

      assert.equal(isQuarterly, true);
    });

    it('should identify last Thursday of December as quarterly', () => {
      // Last Thursday of December 2025 (Dec 25)
      const decExpiry = new Date(2025, 11, 25); // Month 11 = December

      const isQuarterly = expiryManagementService._isQuarterlyExpiry(decExpiry);

      assert.equal(isQuarterly, true);
    });

    it('should not identify non-quarter month as quarterly', () => {
      // Last Thursday of November 2025 (Nov 27)
      const novExpiry = new Date(2025, 10, 27);

      const isQuarterly = expiryManagementService._isQuarterlyExpiry(novExpiry);

      assert.equal(isQuarterly, false);
    });

    it('should not identify non-monthly Thursday as quarterly', () => {
      // First Thursday of March 2025 (Mar 6)
      const marchFirst = new Date(2025, 2, 6);

      const isQuarterly = expiryManagementService._isQuarterlyExpiry(marchFirst);

      assert.equal(isQuarterly, false);
    });
  });

  describe('_processExpiries', () => {
    it('should process and classify expiries correctly', () => {
      const expiries = [
        '2025-11-13', // Weekly (Thursday - Nov 13 is Thursday)
        '2025-11-20', // Weekly (Thursday)
        '2025-11-27', // Monthly (Last Thursday of Nov)
        '2025-12-25', // Quarterly (Last Thursday of Dec)
      ];

      const processed = expiryManagementService._processExpiries(
        expiries,
        'NIFTY',
        'NFO'
      );

      assert.equal(processed.length, 4);

      // Check weekly expiries
      assert.equal(processed[0].is_weekly, true);
      assert.equal(processed[1].is_weekly, true);

      // Check monthly expiry
      assert.equal(processed[2].is_monthly, true);

      // Check quarterly expiry
      assert.equal(processed[3].is_quarterly, true);
      assert.equal(processed[3].is_monthly, true); // Quarterly is also monthly
    });

    it('should skip past expiries', () => {
      // Mock current date to 2025-11-15
      const originalDate = Date;
      global.Date = class extends Date {
        constructor(...args) {
          if (args.length === 0) {
            super('2025-11-15T00:00:00Z');
          } else {
            super(...args);
          }
        }
        static now() {
          return new Date('2025-11-15T00:00:00Z').getTime();
        }
      };

      const expiries = [
        '2025-11-10', // Past
        '2025-11-14', // Past (before 15th)
        '2025-11-21', // Future
        '2025-11-27', // Future
      ];

      const processed = expiryManagementService._processExpiries(
        expiries,
        'NIFTY',
        'NFO'
      );

      // Should only include future expiries (21st and 27th)
      assert.equal(processed.length, 2);
      assert.equal(processed[0].expiry_date, '2025-11-21');
      assert.equal(processed[1].expiry_date, '2025-11-27');

      // Restore original Date
      global.Date = originalDate;
    });

    it('should sort expiries by date', () => {
      const expiries = [
        '2025-11-27',
        '2025-11-14',
        '2025-11-21',
      ];

      const processed = expiryManagementService._processExpiries(
        expiries,
        'NIFTY',
        'NFO'
      );

      assert.equal(processed[0].expiry_date, '2025-11-14');
      assert.equal(processed[1].expiry_date, '2025-11-21');
      assert.equal(processed[2].expiry_date, '2025-11-27');
    });

    it('should set day_of_week correctly', () => {
      const expiries = ['2025-11-13']; // Thursday (Nov 13, 2025 is Thursday)

      const processed = expiryManagementService._processExpiries(
        expiries,
        'NIFTY',
        'NFO'
      );

      assert.equal(processed[0].day_of_week, 'Thursday');
    });
  });

  describe('shouldRefreshExpiry', () => {
    it('should require refresh when never refreshed', () => {
      const shouldRefresh = expiryManagementService.shouldRefreshExpiry(
        'NIFTY',
        'NFO',
        null
      );

      assert.equal(shouldRefresh, true);
    });

    it('should require refresh on Wednesday after 8 AM', () => {
      // Mock current date to Wednesday 8:30 AM
      const originalDate = Date;
      global.Date = class extends Date {
        constructor(...args) {
          if (args.length === 0) {
            super('2025-11-12T08:30:00Z'); // Wednesday
          } else {
            super(...args);
          }
        }
        static now() {
          return new Date('2025-11-12T08:30:00Z').getTime();
        }
      };

      const lastRefresh = new Date('2025-11-05'); // Last week

      const shouldRefresh = expiryManagementService.shouldRefreshExpiry(
        'NIFTY',
        'NFO',
        lastRefresh
      );

      assert.equal(shouldRefresh, true);

      // Restore original Date
      global.Date = originalDate;
    });

    it('should require refresh on Friday after 8 AM', () => {
      // Mock current date to Friday 8:30 AM
      const originalDate = Date;
      global.Date = class extends Date {
        constructor(...args) {
          if (args.length === 0) {
            super('2025-11-14T08:30:00Z'); // Friday
          } else {
            super(...args);
          }
        }
        static now() {
          return new Date('2025-11-14T08:30:00Z').getTime();
        }
      };

      const lastRefresh = new Date('2025-11-07');

      const shouldRefresh = expiryManagementService.shouldRefreshExpiry(
        'NIFTY',
        'NFO',
        lastRefresh
      );

      assert.equal(shouldRefresh, true);

      // Restore original Date
      global.Date = originalDate;
    });

    it('should not require refresh before 8 AM', () => {
      // Mock current date to Wednesday 7:30 AM
      const originalDate = Date;
      global.Date = class extends Date {
        constructor(...args) {
          if (args.length === 0) {
            super('2025-11-12T07:30:00Z'); // Wednesday 7:30 AM
          } else {
            super(...args);
          }
        }
        static now() {
          return new Date('2025-11-12T07:30:00Z').getTime();
        }
      };

      const lastRefresh = new Date('2025-11-05');

      const shouldRefresh = expiryManagementService.shouldRefreshExpiry(
        'NIFTY',
        'NFO',
        lastRefresh
      );

      assert.equal(shouldRefresh, false);

      // Restore original Date
      global.Date = originalDate;
    });

    it('should not require refresh on non-refresh days', () => {
      // Mock current date to Monday 8:30 AM
      const originalDate = Date;
      global.Date = class extends Date {
        constructor(...args) {
          if (args.length === 0) {
            super('2025-11-10T08:30:00Z'); // Monday
          } else {
            super(...args);
          }
        }
        static now() {
          return new Date('2025-11-10T08:30:00Z').getTime();
        }
      };

      const lastRefresh = new Date('2025-11-07');

      const shouldRefresh = expiryManagementService.shouldRefreshExpiry(
        'NIFTY',
        'NFO',
        lastRefresh
      );

      assert.equal(shouldRefresh, false);

      // Restore original Date
      global.Date = originalDate;
    });

    it('should not require refresh if already refreshed today', () => {
      // Mock current date to Wednesday 10:00 AM
      const originalDate = Date;
      global.Date = class extends Date {
        constructor(...args) {
          if (args.length === 0) {
            super('2025-11-12T10:00:00Z'); // Wednesday 10 AM
          } else {
            super(...args);
          }
        }
        static now() {
          return new Date('2025-11-12T10:00:00Z').getTime();
        }
      };

      const lastRefresh = new Date('2025-11-12T08:30:00Z'); // Today 8:30 AM

      const shouldRefresh = expiryManagementService.shouldRefreshExpiry(
        'NIFTY',
        'NFO',
        lastRefresh
      );

      assert.equal(shouldRefresh, false);

      // Restore original Date
      global.Date = originalDate;
    });
  });

  describe('_formatDate', () => {
    it('should format date to YYYY-MM-DD', () => {
      const date = new Date('2025-11-14T10:30:00Z');

      const formatted = expiryManagementService._formatDate(date);

      assert.equal(formatted, '2025-11-14');
    });

    it('should handle single-digit months and days', () => {
      const date = new Date('2025-01-05T10:30:00Z');

      const formatted = expiryManagementService._formatDate(date);

      assert.equal(formatted, '2025-01-05');
    });
  });
});
