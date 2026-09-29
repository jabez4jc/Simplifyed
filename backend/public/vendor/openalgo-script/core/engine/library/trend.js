/**
 * The trend frames that read the bar rather than a source, `stdlib.md`
 * section 4: `psar`, `adx`, `aroon` and `ichimoku`.
 *
 * **Every number here is the numeric library's**, for the reason `series.ts`
 * sets out beside the same wiring. Each entry hands a step the arguments the
 * call supplied and the region the machine holds, and the arithmetic stays in
 * one place.
 *
 * All four return an array, which is the language's own way of handing back
 * more than one number (`stdlib.md` section 2.3), so the value they push is a
 * fresh reference into the heap on every bar.
 *
 * `adx` takes the gap rather than the bar, because its denominator is the
 * gap-aware true range and the previous close in that is the host's, not one
 * remembered here: a call inside a branch does not see every bar, so the close
 * of the bar the call last ran on would be a different number. Its own history,
 * the previous bar's two extremes, is in the region where it belongs.
 */
import { adxStep, aroonStep, ichimokuStep, psarStep } from '../../stdlib/index.js';
import { lengthAt, multi, numberAt } from './binding.js';
import { gapAt, stateful } from './state.js';
export const TREND_ENTRIES = [
    stateful('psar', 'start step max', (ctx, args) => multi(ctx, psarStep(ctx.state, '', ctx.bar, numberAt(args, 0), numberAt(args, 1), numberAt(args, 2)))),
    stateful('adx', 'diLen adxLen', (ctx, args) => multi(ctx, adxStep(ctx.state, '', gapAt(ctx), lengthAt(ctx, 'adx', 'diLen', args, 0), lengthAt(ctx, 'adx', 'adxLen', args, 1)))),
    stateful('aroon', 'len', (ctx, args) => multi(ctx, aroonStep(ctx.state, '', ctx.bar.high, ctx.bar.low, lengthAt(ctx, 'aroon', 'len', args, 0)))),
    stateful('ichimoku', 'convLen baseLen spanLen', (ctx, args) => multi(ctx, ichimokuStep(ctx.state, '', ctx.bar, lengthAt(ctx, 'ichimoku', 'convLen', args, 0), lengthAt(ctx, 'ichimoku', 'baseLen', args, 1), lengthAt(ctx, 'ichimoku', 'spanLen', args, 2)))),
];
//# sourceMappingURL=trend.js.map