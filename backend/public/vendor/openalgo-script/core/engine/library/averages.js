/**
 * The moving averages that take more than a source and a length, `stdlib.md`
 * section 4.
 *
 * **Every number here is the numeric library's**, for the reason `series.ts`
 * sets out beside the same wiring. This file is a table of call sites: it hands
 * each step the arguments a call supplied and the state region the machine
 * holds for that call site, and nothing more.
 *
 * Two of them read the bar as well as their arguments. `vwma` weights by the
 * bar's volume and `ma` may be switched to it, so both are given the volume
 * from the bar being executed rather than from a source argument; a script
 * cannot pass a volume to either, and `stdlib.md` writes neither with one.
 */
import { almaStep, demaStep, isMaType, linregStep, maStep, swmaStep, temaStep, vwmaStep, } from '../../stdlib/index.js';
import { lengthAt, numberAt, stringAt } from './binding.js';
import { stateful } from './state.js';
/** The named average, or absence for a string that is not one of the six. */
export function typeAt(args, index) {
    const named = stringAt(args, index);
    return isMaType(named) ? named : null;
}
/** A source paired with the bar's volume, which is what the weighted forms take. */
export function weighted(ctx, src) {
    return { src, volume: ctx.bar.volume };
}
export const AVERAGE_ENTRIES = [
    stateful('dema', 'src len', (ctx, args) => demaStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'dema', 'len', args, 1))),
    stateful('tema', 'src len', (ctx, args) => temaStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'tema', 'len', args, 1))),
    stateful('vwma', 'src len', (ctx, args) => vwmaStep(ctx.state, '', weighted(ctx, numberAt(args, 0)), lengthAt(ctx, 'vwma', 'len', args, 1))),
    stateful('swma', 'src', (ctx, args) => swmaStep(ctx.state, 'q', numberAt(args, 0))),
    stateful('alma', 'src len offset sigma', (ctx, args) => almaStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'alma', 'len', args, 1), numberAt(args, 2), numberAt(args, 3))),
    stateful('linreg', 'src len offset', (ctx, args) => linregStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'linreg', 'len', args, 1), numberAt(args, 2))),
    // An unrecognised type is absence on every bar rather than a fall back to the
    // simple mean, which `select.ts` gives the reason for: a study that quietly
    // drew a different average from the one its settings name would be wrong in a
    // way nobody could see. A literal is refused at compile time (OS3008); this
    // is the computed case.
    stateful('ma', 'src len type', (ctx, args) => maStep(ctx.state, '', weighted(ctx, numberAt(args, 0)), lengthAt(ctx, 'ma', 'len', args, 1), typeAt(args, 2))),
];
//# sourceMappingURL=averages.js.map