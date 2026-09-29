/**
 * The three readings of `stdlib.md` section 6 that are not wired beside the
 * bands they share a file with: `keltner`, `chop` and `hv`.
 *
 * **Every number here is the numeric library's**, for the reason `series.ts`
 * sets out beside the same wiring.
 *
 * `keltner` and `chop` take the gap rather than the bar, because both are built
 * on a true range and the previous close in one is the host's rather than one
 * remembered at the call site: `range.ts` gives the reason. `keltner` is also
 * handed the close and the volume, because its basis is `ma` over the close and
 * that call can be switched to the volume weighted average.
 */
import { chopStep, hvStep, keltnerStep } from '../../stdlib/index.js';
import { lengthAt, multi, numberAt } from './binding.js';
import { typeAt } from './averages.js';
import { gapAt, stateful } from './state.js';
export const RANGE_ENTRIES = [
    stateful('keltner', 'len mult atrLen maType', (ctx, args) => multi(ctx, keltnerStep(ctx.state, '', gapAt(ctx), ctx.bar.close, ctx.bar.volume, lengthAt(ctx, 'keltner', 'len', args, 0), numberAt(args, 1), lengthAt(ctx, 'keltner', 'atrLen', args, 2), typeAt(args, 3)))),
    stateful('chop', 'len', (ctx, args) => chopStep(ctx.state, '', gapAt(ctx), lengthAt(ctx, 'chop', 'len', args, 0))),
    stateful('hv', 'src len periodsPerYear', (ctx, args) => hvStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'hv', 'len', args, 1), numberAt(args, 2))),
];
//# sourceMappingURL=ranges.js.map