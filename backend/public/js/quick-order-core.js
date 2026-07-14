/**
 * Simplifyed Admin V2 - Quick Order: core class declaration + constructor state.
 * Sibling modules (quick-order-*.js) each add their methods onto QuickOrderHandler.prototype
 * via Object.defineProperties(...Object.getOwnPropertyDescriptors(class {...}.prototype))
 * - see quick-order-init.js for the final instantiation (must load after every mixin file).
 */

class QuickOrderHandler {
  constructor() {
    this.expandedRows = new Set();
    this.defaultQuantities = new Map(); // symbolId -> quantity
    this.selectedTradeModes = new Map(); // symbolId -> tradeMode
    this.selectedOptionsLegs = new Map(); // symbolId -> optionsLeg
    this.selectedExpiries = new Map(); // symbolId -> expiry
    this.availableExpiries = new Map(); // symbolId -> expiry list
    this.selectedProducts = new Map(); // symbolId -> product

    // Buyer/Writer options mode settings (for OPTIONS trade mode only)
    this.operatingModes = new Map(); // symbolId -> 'BUYER' | 'WRITER'
    this.strikePolicies = new Map(); // symbolId -> 'FLOAT_OFS' | 'ANCHOR_OFS'
    this.stepLots = new Map(); // symbolId -> number (contracts per click)
    this.writerGuards = new Map(); // symbolId -> boolean (enable writer guard)
    this.optionPreviewTimers = new Map(); // symbolId -> interval id
    this.optionPreviewRequestIds = new Map(); // symbolId -> latest request token
    this.futuresPreviewTimers = new Map();
    this.futuresPreviewRequestIds = new Map();
    this.optionChainForwardSource = 'carry';
    this.optionChainPrevValues = new Map(); // key: `${underlying}|${expiry}` -> Map of last values
    this.optionChainActiveKey = null;
    this.strikeOffsetSnapshots = new Map(); // symbolId -> { atmStrike, offsets }
  }
}

window.QuickOrderHandler = QuickOrderHandler;
