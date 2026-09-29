/**
 * The momentum readings of `stdlib.md` section 5 that are not already wired
 * beside the studies they share a file with.
 *
 * **Every number here is the numeric library's**, for the reason `series.ts`
 * sets out beside the same wiring. Each entry is a call site and nothing more.
 *
 * Five of them read the bar rather than a source, and `stdlib.md` writes them
 * without one for that reason: `stoch`, `cci`, `williamsR`, `ultimateOsc` and
 * `awesomeOsc` are readings about the whole bar, so there is no source argument
 * for a script to pass and none is invented here.
 */
import { awesomeOscStep, cciStep, cmoStep, dpoStep, ppoStep, stochRsiStep, stochStep, trixStep, tsiStep, ultimateOscStep, williamsRStep, } from '../../stdlib/index.js';
import { lengthAt, multi, numberAt } from './binding.js';
import { stateful } from './state.js';
export const OSCILLATOR_ENTRIES = [
    stateful('stoch', 'len smoothK smoothD', (ctx, args) => multi(ctx, stochStep(ctx.state, '', ctx.bar, lengthAt(ctx, 'stoch', 'len', args, 0), lengthAt(ctx, 'stoch', 'smoothK', args, 1), lengthAt(ctx, 'stoch', 'smoothD', args, 2)))),
    stateful('stochRsi', 'src rsiLen stochLen smoothK smoothD', (ctx, args) => multi(ctx, stochRsiStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'stochRsi', 'rsiLen', args, 1), lengthAt(ctx, 'stochRsi', 'stochLen', args, 2), lengthAt(ctx, 'stochRsi', 'smoothK', args, 3), lengthAt(ctx, 'stochRsi', 'smoothD', args, 4)))),
    stateful('ppo', 'src fast slow signal', (ctx, args) => multi(ctx, ppoStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'ppo', 'fast', args, 1), lengthAt(ctx, 'ppo', 'slow', args, 2), lengthAt(ctx, 'ppo', 'signal', args, 3)))),
    stateful('cci', 'len', (ctx, args) => cciStep(ctx.state, '', ctx.bar, lengthAt(ctx, 'cci', 'len', args, 0))),
    stateful('williamsR', 'len', (ctx, args) => williamsRStep(ctx.state, '', ctx.bar, lengthAt(ctx, 'williamsR', 'len', args, 0))),
    stateful('tsi', 'src longLen shortLen', (ctx, args) => tsiStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'tsi', 'longLen', args, 1), lengthAt(ctx, 'tsi', 'shortLen', args, 2))),
    stateful('trix', 'src len', (ctx, args) => trixStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'trix', 'len', args, 1))),
    stateful('cmo', 'src len', (ctx, args) => cmoStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'cmo', 'len', args, 1))),
    stateful('dpo', 'src len', (ctx, args) => dpoStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'dpo', 'len', args, 1))),
    stateful('ultimateOsc', 'len1 len2 len3', (ctx, args) => ultimateOscStep(ctx.state, '', ctx.bar, lengthAt(ctx, 'ultimateOsc', 'len1', args, 0), lengthAt(ctx, 'ultimateOsc', 'len2', args, 1), lengthAt(ctx, 'ultimateOsc', 'len3', args, 2))),
    stateful('awesomeOsc', 'fast slow', (ctx, args) => awesomeOscStep(ctx.state, '', ctx.bar, lengthAt(ctx, 'awesomeOsc', 'fast', args, 0), lengthAt(ctx, 'awesomeOsc', 'slow', args, 1))),
];
//# sourceMappingURL=oscillators.js.map