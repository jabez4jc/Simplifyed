/**
 * Quick Order Service - Unit Tests
 * Tests order strategy determination and validation
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import quickOrderService from '../../../src/services/quick-order.service.js';

describe('Quick Order Service', () => {
  describe('_determineOrderStrategy', () => {
    it('should return CLOSE_POSITIONS for EXIT action', () => {
      const strategy = quickOrderService._determineOrderStrategy('EXIT', 'EQUITY');
      assert.equal(strategy, 'CLOSE_POSITIONS');
    });

    it('should return CLOSE_POSITIONS for EXIT_ALL action', () => {
      const strategy = quickOrderService._determineOrderStrategy('EXIT_ALL', 'OPTIONS');
      assert.equal(strategy, 'CLOSE_POSITIONS');
    });

    it('should return OPTIONS_WITH_RECONCILIATION for OPTIONS mode with BUY_CE', () => {
      const strategy = quickOrderService._determineOrderStrategy('BUY_CE', 'OPTIONS');
      assert.equal(strategy, 'OPTIONS_WITH_RECONCILIATION');
    });

    it('should return OPTIONS_WITH_RECONCILIATION for OPTIONS mode with SELL_CE', () => {
      const strategy = quickOrderService._determineOrderStrategy('SELL_CE', 'OPTIONS');
      assert.equal(strategy, 'OPTIONS_WITH_RECONCILIATION');
    });

    it('should return OPTIONS_WITH_RECONCILIATION for OPTIONS mode with BUY_PE', () => {
      const strategy = quickOrderService._determineOrderStrategy('BUY_PE', 'OPTIONS');
      assert.equal(strategy, 'OPTIONS_WITH_RECONCILIATION');
    });

    it('should return OPTIONS_WITH_RECONCILIATION for OPTIONS mode with SELL_PE', () => {
      const strategy = quickOrderService._determineOrderStrategy('SELL_PE', 'OPTIONS');
      assert.equal(strategy, 'OPTIONS_WITH_RECONCILIATION');
    });

    it('should return DIRECT_ORDER for EQUITY mode with BUY', () => {
      const strategy = quickOrderService._determineOrderStrategy('BUY', 'EQUITY');
      assert.equal(strategy, 'DIRECT_ORDER');
    });

    it('should return DIRECT_ORDER for EQUITY mode with SELL', () => {
      const strategy = quickOrderService._determineOrderStrategy('SELL', 'EQUITY');
      assert.equal(strategy, 'DIRECT_ORDER');
    });

    it('should return DIRECT_ORDER for FUTURES mode with BUY', () => {
      const strategy = quickOrderService._determineOrderStrategy('BUY', 'FUTURES');
      assert.equal(strategy, 'DIRECT_ORDER');
    });

    it('should return DIRECT_ORDER for FUTURES mode with SELL', () => {
      const strategy = quickOrderService._determineOrderStrategy('SELL', 'FUTURES');
      assert.equal(strategy, 'DIRECT_ORDER');
    });

    it('should return DIRECT_ORDER for OPTIONS mode with regular BUY', () => {
      const strategy = quickOrderService._determineOrderStrategy('BUY', 'OPTIONS');
      assert.equal(strategy, 'DIRECT_ORDER');
    });

    it('should return DIRECT_ORDER for OPTIONS mode with regular SELL', () => {
      const strategy = quickOrderService._determineOrderStrategy('SELL', 'OPTIONS');
      assert.equal(strategy, 'DIRECT_ORDER');
    });

    it('should throw ValidationError for invalid action', () => {
      assert.throws(() => {
        quickOrderService._determineOrderStrategy('INVALID', 'EQUITY');
      }, {
        name: 'ValidationError',
        message: /Unsupported action\/tradeMode combination/,
      });
    });

    it('should throw ValidationError for case-sensitive actions', () => {
      assert.throws(() => {
        quickOrderService._determineOrderStrategy('buy', 'EQUITY');
      }, {
        name: 'ValidationError',
        message: /Unsupported action\/tradeMode combination/,
      });
    });
  });

  describe('_validateOrderParams', () => {
    it('should validate required symbolId parameter', () => {
      const params = {
        // Missing symbolId
        action: 'BUY',
        tradeMode: 'EQUITY',
        quantity: 100,
      };

      assert.throws(() => {
        quickOrderService._validateOrderParams(params);
      }, {
        name: 'ValidationError',
        message: /symbolId is required/,
      });
    });

    it('should validate required action parameter', () => {
      const params = {
        symbolId: 1,
        // Missing action
        tradeMode: 'EQUITY',
        quantity: 100,
      };

      assert.throws(() => {
        quickOrderService._validateOrderParams(params);
      }, {
        name: 'ValidationError',
        message: /action is required/,
      });
    });

    it('should validate required tradeMode parameter', () => {
      const params = {
        symbolId: 1,
        action: 'BUY',
        // Missing tradeMode
        quantity: 100,
      };

      assert.throws(() => {
        quickOrderService._validateOrderParams(params);
      }, {
        name: 'ValidationError',
        message: /tradeMode is required/,
      });
    });

    it('should validate required quantity parameter', () => {
      const params = {
        symbolId: 1,
        action: 'BUY',
        tradeMode: 'EQUITY',
        // Missing quantity
      };

      assert.throws(() => {
        quickOrderService._validateOrderParams(params);
      }, {
        name: 'ValidationError',
        message: /quantity must be greater than 0/,
      });
    });

    it('should validate quantity is greater than 0', () => {
      const params = {
        symbolId: 1,
        action: 'BUY',
        tradeMode: 'EQUITY',
        quantity: 0,
      };

      assert.throws(() => {
        quickOrderService._validateOrderParams(params);
      }, {
        name: 'ValidationError',
        message: /quantity must be greater than 0/,
      });
    });

    it('should validate quantity is not negative', () => {
      const params = {
        symbolId: 1,
        action: 'BUY',
        tradeMode: 'EQUITY',
        quantity: -50,
      };

      assert.throws(() => {
        quickOrderService._validateOrderParams(params);
      }, {
        name: 'ValidationError',
        message: /quantity must be greater than 0/,
      });
    });

    it('should validate action is one of valid values', () => {
      const params = {
        symbolId: 1,
        action: 'INVALID_ACTION',
        tradeMode: 'EQUITY',
        quantity: 100,
      };

      assert.throws(() => {
        quickOrderService._validateOrderParams(params);
      }, {
        name: 'ValidationError',
        message: /action must be one of/,
      });
    });

    it('should validate tradeMode is one of valid values', () => {
      const params = {
        symbolId: 1,
        action: 'BUY',
        tradeMode: 'INVALID_MODE',
        quantity: 100,
      };

      assert.throws(() => {
        quickOrderService._validateOrderParams(params);
      }, {
        name: 'ValidationError',
        message: /tradeMode must be one of/,
      });
    });

    it('should validate OPTIONS actions are only for OPTIONS mode - BUY_CE', () => {
      const params = {
        symbolId: 1,
        action: 'BUY_CE',
        tradeMode: 'EQUITY',
        quantity: 100,
      };

      assert.throws(() => {
        quickOrderService._validateOrderParams(params);
      }, {
        name: 'ValidationError',
        message: /is only valid for OPTIONS trade mode/,
      });
    });

    it('should validate OPTIONS actions are only for OPTIONS mode - SELL_PE', () => {
      const params = {
        symbolId: 1,
        action: 'SELL_PE',
        tradeMode: 'FUTURES',
        quantity: 50,
      };

      assert.throws(() => {
        quickOrderService._validateOrderParams(params);
      }, {
        name: 'ValidationError',
        message: /is only valid for OPTIONS trade mode/,
      });
    });

    it('should validate OPTIONS actions are only for OPTIONS mode - EXIT_ALL', () => {
      const params = {
        symbolId: 1,
        action: 'EXIT_ALL',
        tradeMode: 'EQUITY',
        quantity: 100,
      };

      assert.throws(() => {
        quickOrderService._validateOrderParams(params);
      }, {
        name: 'ValidationError',
        message: /is only valid for OPTIONS trade mode/,
      });
    });

    it('should accept valid EQUITY order parameters', () => {
      const params = {
        symbolId: 1,
        action: 'BUY',
        tradeMode: 'EQUITY',
        quantity: 100,
      };

      // Should not throw
      assert.doesNotThrow(() => {
        quickOrderService._validateOrderParams(params);
      });
    });

    it('should accept valid FUTURES order parameters', () => {
      const params = {
        symbolId: 1,
        action: 'SELL',
        tradeMode: 'FUTURES',
        quantity: 50,
      };

      // Should not throw
      assert.doesNotThrow(() => {
        quickOrderService._validateOrderParams(params);
      });
    });

    it('should accept valid OPTIONS order parameters - BUY_CE', () => {
      const params = {
        symbolId: 1,
        action: 'BUY_CE',
        tradeMode: 'OPTIONS',
        quantity: 75,
      };

      // Should not throw
      assert.doesNotThrow(() => {
        quickOrderService._validateOrderParams(params);
      });
    });

    it('should accept valid OPTIONS order parameters - SELL_PE', () => {
      const params = {
        symbolId: 1,
        action: 'SELL_PE',
        tradeMode: 'OPTIONS',
        quantity: 75,
      };

      // Should not throw
      assert.doesNotThrow(() => {
        quickOrderService._validateOrderParams(params);
      });
    });

    it('should accept EXIT action with any trade mode', () => {
      const params = {
        symbolId: 1,
        action: 'EXIT',
        tradeMode: 'EQUITY',
        quantity: 100,
      };

      // Should not throw
      assert.doesNotThrow(() => {
        quickOrderService._validateOrderParams(params);
      });
    });

    it('should accept EXIT_ALL action with OPTIONS mode', () => {
      const params = {
        symbolId: 1,
        action: 'EXIT_ALL',
        tradeMode: 'OPTIONS',
        quantity: 1,
      };

      // Should not throw
      assert.doesNotThrow(() => {
        quickOrderService._validateOrderParams(params);
      });
    });

    it('should accept all valid action types for appropriate modes', () => {
      const validCombinations = [
        { action: 'BUY', tradeMode: 'EQUITY' },
        { action: 'SELL', tradeMode: 'EQUITY' },
        { action: 'BUY', tradeMode: 'FUTURES' },
        { action: 'SELL', tradeMode: 'FUTURES' },
        { action: 'BUY_CE', tradeMode: 'OPTIONS' },
        { action: 'SELL_CE', tradeMode: 'OPTIONS' },
        { action: 'BUY_PE', tradeMode: 'OPTIONS' },
        { action: 'SELL_PE', tradeMode: 'OPTIONS' },
        { action: 'EXIT', tradeMode: 'OPTIONS' },
        { action: 'EXIT_ALL', tradeMode: 'OPTIONS' },
      ];

      for (const combo of validCombinations) {
        const params = {
          symbolId: 1,
          action: combo.action,
          tradeMode: combo.tradeMode,
          quantity: 100,
        };

        // Should not throw
        assert.doesNotThrow(() => {
          quickOrderService._validateOrderParams(params);
        }, `Should accept ${combo.action} with ${combo.tradeMode}`);
      }
    });
  });
});
