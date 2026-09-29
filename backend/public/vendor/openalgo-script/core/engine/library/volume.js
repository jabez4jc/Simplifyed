/**
 * The volume readings, `stdlib.md` section 7.
 *
 * **Every number here is the numeric library's**, for the reason `series.ts`
 * sets out beside the same wiring.
 *
 * Every one of them is absent on every bar when the host supplies no volume,
 * because an absent volume propagates through the arithmetic exactly as any
 * other absence does. Nothing here substitutes a zero to keep a line drawing: a
 * script tests `chart.hasVolume` to branch on that, which is what section 7
 * says to do.
 *
 * `vwap` resets at the start of each trading session **as the instrument
 * record defines it** rather than at midnight, so the anchor is the session the
 * engine derives from the host's stated hours and not a calendar invented
 * here. A host that states no session leaves that fact absent, and an absent
 * anchor is not an anchor: the average has nothing to measure from and is
 * absent too, which is the same answer any other absent input gives.
 * `vwapAnchor` is the same calculation with the script's own condition as the
 * anchor, which is why the two share one step.
 */
import { adOscStep, adStep, cmfStep, eomStep, forceIndexStep, mfiStep, obvStep, pvtStep, relativeVolumeStep, vwapAnchorStep, vwapStep, } from '../../stdlib/index.js';
import { boolAt, lengthAt, numberAt } from './binding.js';
import { stateful } from './state.js';
export const VOLUME_ENTRIES = [
    stateful('vwap', 'src', (ctx, args) => vwapStep(ctx.state, '', {
        src: numberAt(args, 0),
        volume: ctx.bar.volume,
        // Absence is a condition that did not hold, matching the rule that
        // absence is false at a branch and the sibling call below.
        reset: ctx.bar.isSessionFirst === true,
    })),
    stateful('vwapAnchor', 'src resetWhen', (ctx, args) => vwapAnchorStep(ctx.state, '', {
        src: numberAt(args, 0),
        volume: ctx.bar.volume,
        // An absent condition is a condition that did not hold, matching the rule
        // that absence is false at a branch. Propagating it would leave an
        // anchored average with no anchor for the whole of its source's warmup.
        reset: boolAt(args, 1) === true,
    })),
    stateful('obv', '', (ctx) => obvStep(ctx.state, '', ctx.bar)),
    stateful('ad', '', (ctx) => adStep(ctx.state, '', ctx.bar)),
    stateful('adOsc', 'fast slow', (ctx, args) => adOscStep(ctx.state, '', ctx.bar, lengthAt(ctx, 'adOsc', 'fast', args, 0), lengthAt(ctx, 'adOsc', 'slow', args, 1))),
    stateful('mfi', 'len', (ctx, args) => mfiStep(ctx.state, '', ctx.bar, lengthAt(ctx, 'mfi', 'len', args, 0))),
    stateful('cmf', 'len', (ctx, args) => cmfStep(ctx.state, '', ctx.bar, lengthAt(ctx, 'cmf', 'len', args, 0))),
    stateful('pvt', '', (ctx) => pvtStep(ctx.state, '', ctx.bar)),
    stateful('eom', 'len', (ctx, args) => eomStep(ctx.state, '', ctx.bar, lengthAt(ctx, 'eom', 'len', args, 0))),
    stateful('forceIndex', 'len', (ctx, args) => forceIndexStep(ctx.state, '', ctx.bar, lengthAt(ctx, 'forceIndex', 'len', args, 0))),
    stateful('relativeVolume', 'len', (ctx, args) => relativeVolumeStep(ctx.state, '', ctx.bar.volume, lengthAt(ctx, 'relativeVolume', 'len', args, 0))),
];
//# sourceMappingURL=volume.js.map