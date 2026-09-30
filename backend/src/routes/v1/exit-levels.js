/**
 * Exit levels on the underlying, and the rupee max-loss per position.
 * See services/exit-levels.service.js and services/exit-loss-caps.service.js.
 *
 * Reads need the watchlist view permission; anything that can make the app exit a position
 * needs orders.place.
 */

import express from 'express';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { ValidationError } from '../../core/errors.js';
import exitLevelsService from '../../services/exit-levels.service.js';
import exitLossCapsService from '../../services/exit-loss-caps.service.js';

const router = express.Router();
router.use(requireAuth);

const VIEW = requirePermission('pages.watchlists.view');
const TRADE = requirePermission('orders.place');

const positiveInt = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${name} must be a positive integer`);
  return n;
};
const positiveNumber = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ValidationError(`${name} must be a positive number`);
  return n;
};
const optionalIds = (v) => {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw new ValidationError('instanceIds must be a list of account ids');
  return v.map((id) => positiveInt(id, 'instanceIds[]'));
};
const wrap = (fn) => async (req, res, next) => {
  try {
    res.json({ status: 'success', data: await fn(req) });
  } catch (error) {
    next(error);
  }
};

/** GET /exit-levels?symbolId= - active levels on a chart row (and what fired today). */
router.get('/', VIEW, wrap((req) => exitLevelsService.list(positiveInt(req.query.symbolId, 'symbolId'))));

/** GET /exit-levels/preview?symbolId=&price= - what a level there would do right now. */
router.get('/preview', VIEW, wrap((req) => exitLevelsService.preview(
  positiveInt(req.query.symbolId, 'symbolId'), positiveNumber(req.query.price, 'price')
)));

/** GET /exit-levels/projections?symbolId=&contracts=NFO:SYM,NFO:SYM - estimated premiums. */
router.get('/projections', VIEW, wrap((req) => {
  const contracts = String(req.query.contracts || '').split(',').filter(Boolean).slice(0, 4).map((c) => {
    const [exchange, symbol] = c.split(':');
    if (!exchange || !symbol) throw new ValidationError('contracts must be EXCHANGE:SYMBOL, comma-separated');
    return { exchange, symbol };
  });
  return exitLevelsService.projections(positiveInt(req.query.symbolId, 'symbolId'), contracts);
}));

/** GET /exit-levels/caps?symbolId= - rupee max-loss rules on this chart's underlying. */
router.get('/caps', VIEW, wrap((req) => exitLossCapsService.listCaps(positiveInt(req.query.symbolId, 'symbolId'))));

/** POST /exit-levels - { symbolId, price, coverage, sizeMode, sizeValue, instanceIds, trailing } */
router.post('/', TRADE, wrap((req) => {
  const b = req.body || {};
  return exitLevelsService.create({
    symbolId: positiveInt(b.symbolId, 'symbolId'),
    price: positiveNumber(b.price, 'price'),
    coverage: b.coverage,
    sizeMode: b.sizeMode,
    sizeValue: b.sizeValue,
    instanceIds: optionalIds(b.instanceIds),
    trailing: b.trailing === true,
    userId: req.user?.id || null,
  });
}));

/** POST /exit-levels/caps - { symbolId, exchange, symbol, maxLoss, instanceIds } */
router.post('/caps', TRADE, wrap((req) => {
  const b = req.body || {};
  if (typeof b.exchange !== 'string' || typeof b.symbol !== 'string') throw new ValidationError('exchange and symbol are required');
  return exitLossCapsService.createCap({
    symbolId: positiveInt(b.symbolId, 'symbolId'),
    exchange: b.exchange,
    symbol: b.symbol,
    maxLoss: positiveNumber(b.maxLoss, 'maxLoss'),
    instanceIds: optionalIds(b.instanceIds),
    userId: req.user?.id || null,
  });
}));

/** DELETE /exit-levels/caps/:id */
router.delete('/caps/:id', TRADE, wrap((req) => exitLossCapsService.cancelCap(positiveInt(req.params.id, 'id'))));

/** PATCH /exit-levels/:id - { price } (a drag) */
router.patch('/:id', TRADE, wrap((req) => exitLevelsService.move(
  positiveInt(req.params.id, 'id'), positiveNumber(req.body?.price, 'price')
)));

/** DELETE /exit-levels/:id */
router.delete('/:id', TRADE, wrap((req) => exitLevelsService.cancel(positiveInt(req.params.id, 'id'))));

export default router;
