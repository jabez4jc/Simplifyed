/**
 * The numeric library: the calculations of `stdlib.md` sections 4 to 9.
 *
 * **It depends on nothing else in this repository.** Not the lexer, not the
 * checker, not the engine. A moving average is a moving average, and keeping
 * this tier independently testable is what makes a gate on it worth anything:
 * a number that matches a reference implementation here matches it because the
 * arithmetic is right, not because the rest of the compiler agreed with itself.
 *
 * Three properties hold across everything below, and each has a file that
 * explains it at the place it is implemented:
 *
 * - **Absence is not zero and never becomes zero** (`values/value.ts`). A
 *   warmup bar is absent, anything computed from an absent value is absent, and
 *   the three functions that deliberately ignore absent bars say so in their
 *   names.
 * - **The accumulation order is part of the contract** (`values/lookback.ts`).
 *   Binary64 addition is not associative, so two engines that sum a lookback two
 *   ways disagree in the last bits. Lookbacks are summed fresh, oldest bar first,
 *   and where a formula could be arranged two ways the file that implements it
 *   says which way and why.
 * - **Every function is written once, as a step over a state region**
 *   (`values/region.ts`): a flat record and a step that takes one bar. The tail
 *   form is that step over a region of its own and the whole-series form is the
 *   tail folded, so the live path and the history path cannot disagree, because
 *   there is only one of them. The record rather than a closure is what lets an
 *   engine drive the same step: `compiled-program.md` 2.11 requires a region to
 *   be copyable by something that does not know what is in it, and that is the
 *   reason there is no second copy of any of this arithmetic in the engine.
 *
 * **What this library does not do: raise.** A length outside its contract is
 * OS3004 at compile time or OS4003 at run time, raised before a call reaches
 * here. Nothing below throws, so nothing below can throw a diagnostic without a
 * code.
 *
 * Two arguments appear here that no script writes, and neither is a numeric
 * fact: the tick size `roundToTick` rounds to, which a host states, and the
 * per-bar flag that says where a trading session begins for `vwap`, which an
 * engine derives from the instrument's session hours. An engine supplies
 * both.
 */
export { NONE, at, copyState, flag, fold, held, hl2, hlc3, hlcc4, isLength, isPresent, makeLookback, newState, ohlc4, queue, result, ring, slot, smoothed, tailOf, } from './values/index.js';
export { E, PI, abs, acos, asin, atan, atan2, boolOf, ceil, clamp, cos, exp, floor, hypot, isNone, log, log2, log10, max, min, mod, orElse, pow, round, roundHalfAway, roundTo, roundToStep, roundToTick, scaleOf, sign, sin, sqrt, tan, toDegrees, toRadians, trunc, } from './maths/index.js';
export { civilAt, dateField, dateOfDay, dayNumber, dayOfYearOf, fieldsIn, instantFrom, instantOf, isKnownZone, offsetAt, renderPattern, sameDay, startOf, utcInstantOf, weekOfYearOf, weekdayOfDay, } from './calendar/index.js';
export { alma, almaStep, almaTail, dema, demaStep, demaTail, ema, emaStep, emaTail, hma, hmaStep, hmaTail, isMaType, linreg, linregStep, linregTail, ma, maStep, maTail, rma, rmaStep, rmaTail, sma, smaStep, smaTail, swma, swmaStep, swmaTail, tema, temaStep, temaTail, vwma, vwmaStep, vwmaTail, wma, wmaStep, wmaTail, } from './averages/index.js';
export { avgSkip, avgSkipStep, avgSkipTail, barsSince, barsSinceStep, barsSinceTail, change, changeStep, changeTail, correlation, correlationStep, correlationTail, count, countPresent, countPresentStep, countPresentTail, countStep, countTail, covariance, covarianceStep, covarianceTail, cross, crossDown, crossDownTail, crossEitherTail, crossStep, crossUp, crossUpTail, cum, cumStep, cumTail, extremeStep, falling, fallingTail, highest, highestBars, highestBarsTail, highestTail, history, historyStep, historyTail, lowest, lowestBars, lowestBarsTail, lowestTail, median, medianTail, percentRank, percentRankStep, percentRankTail, percentile, percentileStep, percentileTail, pivotHigh, pivotHighTail, pivotLow, pivotLowTail, pivotStep, rising, risingTail, runStep, sum, sumSkip, sumSkipStep, sumSkipTail, sumStep, sumTail, valueWhen, valueWhenStep, valueWhenTail, } from './series/index.js';
export { atr, atrStep, atrTail, bbPercent, bbPercentStep, bbPercentTail, bbWidth, bbWidthStep, bbWidthTail, bollinger, bollingerStep, bollingerTail, chop, chopStep, chopTail, donchian, donchianStep, donchianTail, gapOf, gapTrueRange, gapTrueRangeStep, gapTrueRangeTail, hv, hvStep, hvTail, keltner, keltnerStep, keltnerTail, meanDeviation, meanDeviationStep, meanDeviationTail, natr, natrStep, natrTail, stdev, stdevStep, stdevTail, trueRange, trueRangeOf, trueRangeTail, variance, varianceStep, varianceTail, } from './volatility/index.js';
export { awesomeOsc, awesomeOscStep, awesomeOscTail, cci, cciStep, cciTail, cmo, cmoStep, cmoTail, dpo, dpoStep, dpoTail, macd, macdStep, macdTail, mom, momTail, ppo, ppoStep, ppoTail, roc, rocStep, rocTail, rsi, rsiStep, rsiTail, stoch, stochRsi, stochRsiStep, stochRsiTail, stochStep, stochTail, trix, trixStep, trixTail, tsi, tsiStep, tsiTail, ultimateOsc, ultimateOscStep, ultimateOscTail, williamsR, williamsRStep, williamsRTail, } from './momentum/index.js';
export { adx, adxStep, adxTail, aroon, aroonStep, aroonTail, ichimoku, ichimokuStep, ichimokuTail, psar, psarStep, psarTail, supertrend, supertrendStep, supertrendTail, } from './trend/index.js';
export { ad, adOsc, adOscStep, adOscTail, adStep, adTail, cmf, cmfStep, cmfTail, eom, eomStep, eomTail, forceIndex, forceIndexStep, forceIndexTail, mfi, mfiStep, mfiTail, moneyFlow, obv, obvStep, obvTail, pvt, pvtStep, pvtTail, relativeVolume, relativeVolumeStep, relativeVolumeTail, vwap, vwapAnchor, vwapAnchorStep, vwapAnchorTail, vwapStep, vwapTail, } from './volume/index.js';
//# sourceMappingURL=index.js.map