/**
 * Symbol Classification Service - Unit Tests
 * Tests symbol tradability detection logic
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import symbolClassificationService from '../../../src/services/symbol-classification.service.js';

describe('Symbol Classification Service', () => {
  describe('classifySymbol', () => {
    it('should classify pure equity symbol (no F&O)', () => {
      const searchResults = [
        {
          symbol: 'ITC',
          name: 'ITC',
          exchange: 'NSE',
          instrumenttype: 'EQ',
          expiry: '',
          strike: null,
          option_type: null,
        },
      ];

      const result = symbolClassificationService.classifySymbol(searchResults, 'ITC');

      assert.equal(result.tradable_equity, true);
      assert.equal(result.tradable_futures, false);
      assert.equal(result.tradable_options, false);
      assert.equal(result.classification, 'EQUITY_ONLY');
      assert.equal(result.underlying, 'ITC');
    });

    it('should classify equity symbol with F&O eligibility', () => {
      const searchResults = [
        {
          symbol: 'RELIANCE',
          name: 'RELIANCE',
          exchange: 'NSE',
          instrumenttype: 'EQ',
          expiry: '',
          strike: null,
          option_type: null,
        },
        {
          symbol: 'RELIANCE25NOVFUT',
          name: 'RELIANCE',
          exchange: 'NFO',
          instrumenttype: 'FUTSTK',
          expiry: '2025-11-27',
          strike: null,
          option_type: null,
        },
        {
          symbol: 'RELIANCE25NOV2450CE',
          name: 'RELIANCE',
          exchange: 'NFO',
          instrumenttype: 'OPTSTK',
          expiry: '2025-11-27',
          strike: 2450,
          option_type: 'CE',
        },
      ];

      const result = symbolClassificationService.classifySymbol(searchResults, 'RELIANCE');

      assert.equal(result.tradable_equity, true);
      assert.equal(result.tradable_futures, true);
      assert.equal(result.tradable_options, true);
      assert.equal(result.classification, 'EQUITY_FNO');
      assert.equal(result.underlying, 'RELIANCE');
    });

    it('should classify index symbol (Futures/Options only)', () => {
      const searchResults = [
        {
          symbol: 'NIFTY25NOVFUT',
          name: 'NIFTY',
          exchange: 'NFO',
          instrumenttype: 'FUTIDX',
          expiry: '2025-11-28',
          strike: null,
          option_type: null,
        },
        {
          symbol: 'NIFTY25NOV25000CE',
          name: 'NIFTY',
          exchange: 'NFO',
          instrumenttype: 'OPTIDX',
          expiry: '2025-11-28',
          strike: 25000,
          option_type: 'CE',
        },
      ];

      const result = symbolClassificationService.classifySymbol(searchResults, 'NIFTY');

      assert.equal(result.tradable_equity, false);
      assert.equal(result.tradable_futures, true);
      assert.equal(result.tradable_options, true);
      assert.equal(result.classification, 'INDEX');
      assert.equal(result.underlying, 'NIFTY');
    });

    it('should classify direct option contract', () => {
      const searchResults = [
        {
          symbol: 'NIFTY25NOV25000CE',
          name: 'NIFTY',
          exchange: 'NFO',
          instrumenttype: 'OPTIDX',
          expiry: '2025-11-28',
          strike: 25000,
          option_type: 'CE',
        },
      ];

      const result = symbolClassificationService.classifySymbol(searchResults, 'NIFTY25NOV25000CE');

      assert.equal(result.tradable_equity, false);
      assert.equal(result.tradable_futures, false);
      assert.equal(result.tradable_options, true);
      assert.equal(result.classification, 'OPTIONS_ONLY');
    });

    it('should classify futures-only symbol', () => {
      const searchResults = [
        {
          symbol: 'NIFTY25NOVFUT',
          name: 'NIFTY',
          exchange: 'NFO',
          instrumenttype: 'FUTIDX',
          expiry: '2025-11-28',
          strike: null,
          option_type: null,
        },
      ];

      const result = symbolClassificationService.classifySymbol(searchResults, 'NIFTY25NOVFUT');

      assert.equal(result.tradable_equity, false);
      assert.equal(result.tradable_futures, true);
      assert.equal(result.tradable_options, false);
      assert.equal(result.classification, 'FUTURES_ONLY');
    });

    it('should handle empty search results', () => {
      const result = symbolClassificationService.classifySymbol([], 'INVALID');

      assert.equal(result.tradable_equity, false);
      assert.equal(result.tradable_futures, false);
      assert.equal(result.tradable_options, false);
      assert.equal(result.classification, 'UNKNOWN');
      assert.equal(result.reason, 'No search results');
    });

    it('should handle null search results', () => {
      const result = symbolClassificationService.classifySymbol(null, 'INVALID');

      assert.equal(result.tradable_equity, false);
      assert.equal(result.tradable_futures, false);
      assert.equal(result.tradable_options, false);
      assert.equal(result.classification, 'UNKNOWN');
    });
  });

  describe('_isEquity', () => {
    it('should identify equity by instrument type', () => {
      const result = {
        symbol: 'RELIANCE',
        name: 'RELIANCE',
        instrumenttype: 'EQ',
        expiry: '',
      };

      assert.equal(symbolClassificationService._isEquity(result), true);
    });

    it('should identify equity by name == symbol and no expiry', () => {
      const result = {
        symbol: 'TCS',
        name: 'TCS',
        instrumenttype: '',
        expiry: '',
      };

      assert.equal(symbolClassificationService._isEquity(result), true);
    });

    it('should not identify futures as equity', () => {
      const result = {
        symbol: 'NIFTY25NOVFUT',
        name: 'NIFTY',
        instrumenttype: 'FUTIDX',
        expiry: '2025-11-28',
      };

      assert.equal(symbolClassificationService._isEquity(result), false);
    });
  });

  describe('_isFutures', () => {
    it('should identify futures by instrument type (FUTSTK)', () => {
      const result = {
        symbol: 'RELIANCE25NOVFUT',
        name: 'RELIANCE',
        instrumenttype: 'FUTSTK',
        expiry: '2025-11-27',
      };

      assert.equal(symbolClassificationService._isFutures(result), true);
    });

    it('should identify futures by instrument type (FUTIDX)', () => {
      const result = {
        symbol: 'NIFTY25NOVFUT',
        name: 'NIFTY',
        instrumenttype: 'FUTIDX',
        expiry: '2025-11-28',
      };

      assert.equal(symbolClassificationService._isFutures(result), true);
    });

    it('should identify futures by symbol pattern', () => {
      const result = {
        symbol: 'BANKNIFTY25NOVFUT',
        name: 'BANKNIFTY',
        instrumenttype: '',
        expiry: '2025-11-27',
      };

      assert.equal(symbolClassificationService._isFutures(result), true);
    });

    it('should not identify options as futures', () => {
      const result = {
        symbol: 'NIFTY25NOV25000CE',
        name: 'NIFTY',
        instrumenttype: 'OPTIDX',
        expiry: '2025-11-28',
        strike: 25000,
      };

      assert.equal(symbolClassificationService._isFutures(result), false);
    });
  });

  describe('_isOptions', () => {
    it('should identify options by instrument type (OPTIDX)', () => {
      const result = {
        symbol: 'NIFTY25NOV25000CE',
        name: 'NIFTY',
        instrumenttype: 'OPTIDX',
        expiry: '2025-11-28',
        strike: 25000,
        option_type: 'CE',
      };

      assert.equal(symbolClassificationService._isOptions(result), true);
    });

    it('should identify options by instrument type (OPTSTK)', () => {
      const result = {
        symbol: 'RELIANCE25NOV2450PE',
        name: 'RELIANCE',
        instrumenttype: 'OPTSTK',
        expiry: '2025-11-27',
        strike: 2450,
        option_type: 'PE',
      };

      assert.equal(symbolClassificationService._isOptions(result), true);
    });

    it('should identify options by symbol pattern (CE)', () => {
      const result = {
        symbol: 'NIFTY25NOV25000CE',
        name: 'NIFTY',
        instrumenttype: '',
        expiry: '2025-11-28',
        strike: 25000,
      };

      assert.equal(symbolClassificationService._isOptions(result), true);
    });

    it('should identify options by symbol pattern (PE)', () => {
      const result = {
        symbol: 'NIFTY25NOV25000PE',
        name: 'NIFTY',
        instrumenttype: '',
        expiry: '2025-11-28',
        strike: 25000,
      };

      assert.equal(symbolClassificationService._isOptions(result), true);
    });

    it('should identify options by option_type field', () => {
      const result = {
        symbol: 'CUSTOM',
        name: 'CUSTOM',
        instrumenttype: '',
        expiry: '2025-11-28',
        strike: 100,
        option_type: 'CE',
      };

      assert.equal(symbolClassificationService._isOptions(result), true);
    });

    it('should not identify futures as options', () => {
      const result = {
        symbol: 'NIFTY25NOVFUT',
        name: 'NIFTY',
        instrumenttype: 'FUTIDX',
        expiry: '2025-11-28',
      };

      assert.equal(symbolClassificationService._isOptions(result), false);
    });
  });

  describe('_extractUnderlying', () => {
    it('should extract underlying from equity symbol', () => {
      const results = [
        {
          symbol: 'RELIANCE',
          name: 'RELIANCE',
          instrumenttype: 'EQ',
        },
      ];

      const underlying = symbolClassificationService._extractUnderlying(results);
      assert.equal(underlying, 'RELIANCE');
    });

    it('should extract underlying from F&O name', () => {
      const results = [
        {
          symbol: 'NIFTY25NOVFUT',
          name: 'NIFTY',
          instrumenttype: 'FUTIDX',
        },
      ];

      const underlying = symbolClassificationService._extractUnderlying(results);
      assert.equal(underlying, 'NIFTY');
    });

    it('should remove -EQ suffix from equity symbol', () => {
      const results = [
        {
          symbol: 'TCS-EQ',
          name: 'TCS',
          instrumenttype: 'EQ',
        },
      ];

      const underlying = symbolClassificationService._extractUnderlying(results);
      assert.equal(underlying, 'TCS');
    });
  });

  describe('getControlAvailability', () => {
    it('should return correct controls for EQUITY_ONLY', () => {
      const classification = {
        classification: 'EQUITY_ONLY',
        tradable_equity: true,
        tradable_futures: false,
        tradable_options: false,
      };

      const controls = symbolClassificationService.getControlAvailability(classification);

      assert.equal(controls.show_equity_toggle, false);
      assert.equal(controls.show_futures_toggle, false);
      assert.equal(controls.show_options_controls, false);
      assert.equal(controls.default_mode, 'EQUITY');
    });

    it('should return correct controls for EQUITY_FNO', () => {
      const classification = {
        classification: 'EQUITY_FNO',
        tradable_equity: true,
        tradable_futures: true,
        tradable_options: true,
      };

      const controls = symbolClassificationService.getControlAvailability(classification);

      assert.equal(controls.show_equity_toggle, true);
      assert.equal(controls.show_futures_toggle, true);
      assert.equal(controls.show_options_controls, true);
      assert.equal(controls.default_mode, 'EQUITY');
    });

    it('should return correct controls for INDEX', () => {
      const classification = {
        classification: 'INDEX',
        tradable_equity: false,
        tradable_futures: true,
        tradable_options: true,
      };

      const controls = symbolClassificationService.getControlAvailability(classification);

      assert.equal(controls.show_equity_toggle, false);
      assert.equal(controls.show_futures_toggle, true);
      assert.equal(controls.show_options_controls, true);
      assert.equal(controls.default_mode, 'FUTURES');
    });

    it('should return correct controls for OPTIONS_ONLY', () => {
      const classification = {
        classification: 'OPTIONS_ONLY',
        tradable_equity: false,
        tradable_futures: false,
        tradable_options: true,
      };

      const controls = symbolClassificationService.getControlAvailability(classification);

      assert.equal(controls.show_equity_toggle, false);
      assert.equal(controls.show_futures_toggle, false);
      assert.equal(controls.show_options_controls, false);
      assert.equal(controls.default_mode, 'OPTIONS');
    });

    it('should return correct controls for FUTURES_ONLY', () => {
      const classification = {
        classification: 'FUTURES_ONLY',
        tradable_equity: false,
        tradable_futures: true,
        tradable_options: false,
      };

      const controls = symbolClassificationService.getControlAvailability(classification);

      assert.equal(controls.show_equity_toggle, false);
      assert.equal(controls.show_futures_toggle, true);
      assert.equal(controls.show_options_controls, false);
      assert.equal(controls.default_mode, 'FUTURES');
    });

    it('should return safe defaults for UNKNOWN classification', () => {
      const classification = {
        classification: 'UNKNOWN',
        tradable_equity: false,
        tradable_futures: false,
        tradable_options: false,
      };

      const controls = symbolClassificationService.getControlAvailability(classification);

      assert.equal(controls.show_equity_toggle, false);
      assert.equal(controls.show_futures_toggle, false);
      assert.equal(controls.show_options_controls, false);
      assert.equal(controls.default_mode, 'EQUITY');
    });
  });
});
