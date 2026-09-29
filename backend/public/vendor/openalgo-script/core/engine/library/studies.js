/**
 * The studies: range, deviation, bands, the strength reading and the two trend
 * calls.
 *
 * **Every number here is the numeric library's**, for the reason `series.ts`
 * sets out beside the same wiring. Each study is a composition there and
 * nothing more, which is the point of writing the library as steps over a state
 * region: `atr` is `rma` over true range, `rsi` is two `rma`s over the two
 * halves of a change, `bollinger` is `sma` and `stdev`, and `macd` is three
 * `ema`s. A composition keeps one accumulation order rather than inventing a
 * second, and it is why the warmups in `stdlib.md` compose instead of being
 * asserted.
 *
 * The several calls that return more than one number return an array, which is
 * the language's own way of handing back a trio (`stdlib.md` sections 5 and 6),
 * so the value they push is a fresh reference into the heap on every bar.
 */
import { atrStep, bbPercentStep, bbWidthStep, bollingerStep, donchianStep, macdStep, natrStep, rsiStep, stdevStep, supertrendStep, trueRangeOf, varianceStep, } from '../../stdlib/index.js';
import { boolAt, entry, lengthAt, multi, numberAt } from './binding.js';
import { gapAt, stateful } from './state.js';
export const STUDY_ENTRIES = [
    entry('trueRange', '', (ctx) => trueRangeOf(gapAt(ctx), true)),
    stateful('atr', 'len', (ctx, args) => atrStep(ctx.state, '', gapAt(ctx), lengthAt(ctx, 'atr', 'len', args, 0))),
    stateful('natr', 'len', (ctx, args) => natrStep(ctx.state, '', gapAt(ctx), ctx.bar.close, lengthAt(ctx, 'natr', 'len', args, 0))),
    stateful('stdev', 'src len sample', (ctx, args) => stdevStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'stdev', 'len', args, 1), boolAt(args, 2) === true)),
    stateful('variance', 'src len sample', (ctx, args) => varianceStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'variance', 'len', args, 1), boolAt(args, 2) === true)),
    stateful('rsi', 'src len', (ctx, args) => rsiStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'rsi', 'len', args, 1))),
    stateful('bollinger', 'src len mult', (ctx, args) => multi(ctx, bollingerStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'bollinger', 'len', args, 1), numberAt(args, 2)))),
    stateful('bbWidth', 'src len mult', (ctx, args) => bbWidthStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'bbWidth', 'len', args, 1), numberAt(args, 2))),
    stateful('bbPercent', 'src len mult', (ctx, args) => bbPercentStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'bbPercent', 'len', args, 1), numberAt(args, 2))),
    stateful('macd', 'src fast slow signal', (ctx, args) => multi(ctx, macdStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'macd', 'fast', args, 1), lengthAt(ctx, 'macd', 'slow', args, 2), lengthAt(ctx, 'macd', 'signal', args, 3)))),
    stateful('supertrend', 'factor atrLen', (ctx, args) => multi(ctx, supertrendStep(ctx.state, '', gapAt(ctx), ctx.bar.close, numberAt(args, 0), lengthAt(ctx, 'supertrend', 'atrLen', args, 1)))),
    stateful('donchian', 'len', (ctx, args) => multi(ctx, donchianStep(ctx.state, '', ctx.bar.high, ctx.bar.low, lengthAt(ctx, 'donchian', 'len', args, 0)))),
];
//# sourceMappingURL=studies.js.map