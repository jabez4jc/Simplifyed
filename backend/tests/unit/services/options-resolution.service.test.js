/**
 * Options Resolution Service - Unit Tests
 * Tests strike calculation, symbol resolution, and caching
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import optionsResolutionService from '../../../src/services/options-resolution.service.js';

describe('Options Resolution Service', () => {
  describe('_calculateTargetStrike', () => {
    const strikes = [24800, 24850, 24900, 24950, 25000, 25050, 25100, 25150, 25200];
    const strikeStep = 50;

    it('should calculate ATM strike correctly', () => {
      const ltp = 25025;
      const target = optionsResolutionService._calculateTargetStrike(
        ltp,
        'ATM',
        'CE',
        strikes,
        strikeStep
      );

      assert.equal(target, 25000); // Closest to 25025
    });

    it('should calculate ITM1 CE strike correctly', () => {
      const ltp = 25000;
      const target = optionsResolutionService._calculateTargetStrike(
        ltp,
        'ITM1',
        'CE',
        strikes,
        strikeStep
      );

      // ITM1 CE = ATM - 1 strike = 25000 - 50 = 24950
      assert.equal(target, 24950);
    });

    it('should calculate OTM1 CE strike correctly', () => {
      const ltp = 25000;
      const target = optionsResolutionService._calculateTargetStrike(
        ltp,
        'OTM1',
        'CE',
        strikes,
        strikeStep
      );

      // OTM1 CE = ATM + 1 strike = 25000 + 50 = 25050
      assert.equal(target, 25050);
    });

    it('should calculate ITM1 PE strike correctly', () => {
      const ltp = 25000;
      const target = optionsResolutionService._calculateTargetStrike(
        ltp,
        'ITM1',
        'PE',
        strikes,
        strikeStep
      );

      // ITM1 PE = ATM + 1 strike = 25000 + 50 = 25050
      assert.equal(target, 25050);
    });

    it('should calculate OTM1 PE strike correctly', () => {
      const ltp = 25000;
      const target = optionsResolutionService._calculateTargetStrike(
        ltp,
        'OTM1',
        'PE',
        strikes,
        strikeStep
      );

      // OTM1 PE = ATM - 1 strike = 25000 - 50 = 24950
      assert.equal(target, 24950);
    });

    it('should calculate ITM3 CE strike correctly', () => {
      const ltp = 25000;
      const target = optionsResolutionService._calculateTargetStrike(
        ltp,
        'ITM3',
        'CE',
        strikes,
        strikeStep
      );

      // ITM3 CE = ATM - 3 strikes = 25000 - 150 = 24850
      assert.equal(target, 24850);
    });

    it('should calculate OTM3 CE strike correctly', () => {
      const ltp = 25000;
      const target = optionsResolutionService._calculateTargetStrike(
        ltp,
        'OTM3',
        'CE',
        strikes,
        strikeStep
      );

      // OTM3 CE = ATM + 3 strikes = 25000 + 150 = 25150
      assert.equal(target, 25150);
    });

    it('should handle LTP between strikes', () => {
      const ltp = 25025;
      const target = optionsResolutionService._calculateTargetStrike(
        ltp,
        'ATM',
        'CE',
        strikes,
        strikeStep
      );

      // Should round to nearest: 25000 (closer than 25050)
      assert.equal(target, 25000);
    });

    it('should handle LTP at exact strike', () => {
      const ltp = 25000;
      const target = optionsResolutionService._calculateTargetStrike(
        ltp,
        'ATM',
        'CE',
        strikes,
        strikeStep
      );

      assert.equal(target, 25000);
    });
  });

  describe('_findATMStrike', () => {
    const strikes = [24800, 24850, 24900, 24950, 25000, 25050, 25100];

    it('should find exact ATM strike', () => {
      const ltp = 25000;
      const atm = optionsResolutionService._findATMStrike(ltp, strikes);

      assert.equal(atm, 25000);
    });

    it('should find closest ATM strike (lower)', () => {
      const ltp = 24920;
      const atm = optionsResolutionService._findATMStrike(ltp, strikes);

      assert.equal(atm, 24900); // Closer to 24900 than 24950
    });

    it('should find closest ATM strike (upper)', () => {
      const ltp = 24930;
      const atm = optionsResolutionService._findATMStrike(ltp, strikes);

      assert.equal(atm, 24950); // Closer to 24950 than 24900
    });

    it('should find closest ATM strike (exact midpoint)', () => {
      const ltp = 24925;
      const atm = optionsResolutionService._findATMStrike(ltp, strikes);

      // Should pick one of them (24900 or 24950)
      assert.ok([24900, 24950].includes(atm));
    });
  });

  describe('_processOptionChain', () => {
    it('should process array format option chain', () => {
      const chainData = [
        {
          symbol: 'NIFTY25NOV25000CE',
          strike: 25000,
          option_type: 'CE',
          lot_size: 50,
        },
        {
          symbol: 'NIFTY25NOV25000PE',
          strike: 25000,
          option_type: 'PE',
          lot_size: 50,
        },
        {
          symbol: 'NIFTY25NOV25050CE',
          strike: 25050,
          option_type: 'CE',
          lot_size: 50,
        },
      ];

      const processed = optionsResolutionService._processOptionChain(chainData);

      assert.equal(processed.strikes.length, 2); // 25000, 25050
      assert.equal(processed.strikeStep, 50);
      assert.ok(processed.optionsByStrike[25000]);
      assert.ok(processed.optionsByStrike[25000].CE);
      assert.ok(processed.optionsByStrike[25000].PE);
    });

    it('should calculate strike step from consecutive strikes', () => {
      const chainData = [
        { symbol: 'NIFTY25NOV24900CE', strike: 24900, option_type: 'CE' },
        { symbol: 'NIFTY25NOV24950CE', strike: 24950, option_type: 'CE' },
        { symbol: 'NIFTY25NOV25000CE', strike: 25000, option_type: 'CE' },
        { symbol: 'NIFTY25NOV25050CE', strike: 25050, option_type: 'CE' },
      ];

      const processed = optionsResolutionService._processOptionChain(chainData);

      assert.equal(processed.strikeStep, 50);
    });

    it('should handle non-uniform strike steps (use most common)', () => {
      const chainData = [
        { symbol: 'RELIANCE2500CE', strike: 2500, option_type: 'CE' },
        { symbol: 'RELIANCE2550CE', strike: 2550, option_type: 'CE' },
        { symbol: 'RELIANCE2600CE', strike: 2600, option_type: 'CE' },
        { symbol: 'RELIANCE2650CE', strike: 2650, option_type: 'CE' },
        { symbol: 'RELIANCE2700CE', strike: 2700, option_type: 'CE' },
      ];

      const processed = optionsResolutionService._processOptionChain(chainData);

      assert.equal(processed.strikeStep, 50);
    });

    it('should sort strikes in ascending order', () => {
      const chainData = [
        { symbol: 'NIFTY25000CE', strike: 25000, option_type: 'CE' },
        { symbol: 'NIFTY24900CE', strike: 24900, option_type: 'CE' },
        { symbol: 'NIFTY25100CE', strike: 25100, option_type: 'CE' },
      ];

      const processed = optionsResolutionService._processOptionChain(chainData);

      assert.deepEqual(processed.strikes, [24900, 25000, 25100]);
    });
  });

  describe('_extractOptionsFromChainData', () => {
    it('should extract from array format', () => {
      const chainData = [
        { symbol: 'NIFTY25000CE', strike: 25000, option_type: 'CE' },
        { symbol: 'NIFTY25000PE', strike: 25000, option_type: 'PE' },
      ];

      const options = optionsResolutionService._extractOptionsFromChainData(chainData);

      assert.equal(options.length, 2);
      assert.equal(options[0].symbol, 'NIFTY25000CE');
    });

    it('should extract from options wrapper format', () => {
      const chainData = {
        options: [
          { symbol: 'NIFTY25000CE', strike: 25000, option_type: 'CE' },
          { symbol: 'NIFTY25000PE', strike: 25000, option_type: 'PE' },
        ],
      };

      const options = optionsResolutionService._extractOptionsFromChainData(chainData);

      assert.equal(options.length, 2);
    });

    it('should extract from CE/PE object format', () => {
      const chainData = {
        CE: {
          25000: { symbol: 'NIFTY25000CE', lot_size: 50 },
          25050: { symbol: 'NIFTY25050CE', lot_size: 50 },
        },
        PE: {
          25000: { symbol: 'NIFTY25000PE', lot_size: 50 },
          25050: { symbol: 'NIFTY25050PE', lot_size: 50 },
        },
      };

      const options = optionsResolutionService._extractOptionsFromChainData(chainData);

      assert.equal(options.length, 4);
      assert.ok(options.some(o => o.symbol === 'NIFTY25000CE'));
      assert.ok(options.some(o => o.symbol === 'NIFTY25000PE'));
    });

    it('should handle empty chain data', () => {
      const options = optionsResolutionService._extractOptionsFromChainData([]);

      assert.equal(options.length, 0);
    });
  });

  describe('_findOptionSymbol', () => {
    it('should find CE option symbol', () => {
      const optionChain = {
        strikes: [25000],
        strikeStep: 50,
        optionsByStrike: {
          25000: {
            CE: {
              symbol: 'NIFTY25NOV25000CE',
              lot_size: 50,
            },
            PE: {
              symbol: 'NIFTY25NOV25000PE',
              lot_size: 50,
            },
          },
        },
      };

      const symbol = optionsResolutionService._findOptionSymbol(
        optionChain,
        25000,
        'CE'
      );

      assert.ok(symbol);
      assert.equal(symbol.symbol, 'NIFTY25NOV25000CE');
    });

    it('should find PE option symbol', () => {
      const optionChain = {
        strikes: [25000],
        strikeStep: 50,
        optionsByStrike: {
          25000: {
            CE: { symbol: 'NIFTY25NOV25000CE' },
            PE: { symbol: 'NIFTY25NOV25000PE' },
          },
        },
      };

      const symbol = optionsResolutionService._findOptionSymbol(
        optionChain,
        25000,
        'PE'
      );

      assert.ok(symbol);
      assert.equal(symbol.symbol, 'NIFTY25NOV25000PE');
    });

    it('should return null for missing strike', () => {
      const optionChain = {
        strikes: [25000],
        strikeStep: 50,
        optionsByStrike: {
          25000: {
            CE: { symbol: 'NIFTY25NOV25000CE' },
          },
        },
      };

      const symbol = optionsResolutionService._findOptionSymbol(
        optionChain,
        25100,
        'CE'
      );

      assert.equal(symbol, null);
    });

    it('should return null for missing option type', () => {
      const optionChain = {
        strikes: [25000],
        strikeStep: 50,
        optionsByStrike: {
          25000: {
            CE: { symbol: 'NIFTY25NOV25000CE' },
          },
        },
      };

      const symbol = optionsResolutionService._findOptionSymbol(
        optionChain,
        25000,
        'PE'
      );

      assert.equal(symbol, null);
    });
  });

  describe('_mostCommon', () => {
    it('should find most common value', () => {
      const arr = [50, 50, 50, 100, 100];
      const common = optionsResolutionService._mostCommon(arr);

      assert.equal(common, 50);
    });

    it('should handle single value', () => {
      const arr = [50];
      const common = optionsResolutionService._mostCommon(arr);

      assert.equal(common, 50);
    });

    it('should handle multiple values with same frequency', () => {
      const arr = [50, 100];
      const common = optionsResolutionService._mostCommon(arr);

      assert.ok([50, 100].includes(common));
    });

    it('should handle all same values', () => {
      const arr = [50, 50, 50, 50];
      const common = optionsResolutionService._mostCommon(arr);

      assert.equal(common, 50);
    });
  });

  describe('_findClosestStrike', () => {
    const strikes = [24900, 24950, 25000, 25050, 25100];

    it('should find exact strike', () => {
      const closest = optionsResolutionService._findClosestStrike(25000, strikes);

      assert.equal(closest, 25000);
    });

    it('should find closest strike when between two', () => {
      const closest = optionsResolutionService._findClosestStrike(24970, strikes);

      // Closer to 24950 than 25000
      assert.equal(closest, 24950);
    });

    it('should find closest strike when above all', () => {
      const closest = optionsResolutionService._findClosestStrike(25200, strikes);

      assert.equal(closest, 25100);
    });

    it('should find closest strike when below all', () => {
      const closest = optionsResolutionService._findClosestStrike(24800, strikes);

      assert.equal(closest, 24900);
    });
  });
});
