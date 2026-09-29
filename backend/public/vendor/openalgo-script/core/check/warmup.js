/** A value on the very first bar. */
export const BAR_ZERO = { kind: 'at', bar: 0 };
export const NEVER = { kind: 'never' };
export function atBar(bar) {
    return { kind: 'at', bar: Math.max(0, Math.trunc(bar)) };
}
export function atLeastBar(bar) {
    return { kind: 'atLeast', bar: Math.max(0, Math.trunc(bar)) };
}
/** The floor of a warmup, for a rule that can only give a lower bound. */
export function weaken(warmup) {
    return warmup.kind === 'at' ? atLeastBar(warmup.bar) : warmup;
}
/**
 * The warmup of something that needs both of two values.
 *
 * Arithmetic propagates absence (language.md 6.2), so a sum is absent until
 * both sides are present: the later of the two. An operand that is never
 * present makes the whole thing never present.
 */
export function later(left, right) {
    if (left.kind === 'never' || right.kind === 'never')
        return NEVER;
    const bar = Math.max(left.bar, right.bar);
    return left.kind === 'at' && right.kind === 'at' ? atBar(bar) : atLeastBar(bar);
}
/**
 * The warmup of something that needs either of two values.
 *
 * `orElse(x, fallback)` and a ternary whose arms warm up at different bars are
 * both this: present as soon as the earlier one is.
 */
export function earlier(left, right) {
    if (left.kind === 'never')
        return right;
    if (right.kind === 'never')
        return left;
    const bar = Math.min(left.bar, right.bar);
    return left.kind === 'at' && right.kind === 'at' ? atBar(bar) : atLeastBar(bar);
}
/** The warmup of every one of these together, or bar 0 when there are none. */
export function allOf(warmups) {
    return warmups.reduce(later, BAR_ZERO);
}
/**
 * The same value, delayed by a stated number of bars.
 *
 * This is how a library entry's declared length composes with its source's:
 * `sma(ema(close, 10), 10)` is absent until bar 18 because each call delays
 * whatever it was given by its own length, and stdlib.md section 1 says so.
 */
export function delayed(warmup, bars) {
    if (warmup.kind === 'never')
        return NEVER;
    const bar = warmup.bar + Math.trunc(bars);
    return warmup.kind === 'at' ? atBar(bar) : atLeastBar(bar);
}
/** Whether this value is absent on every bar, which is what OS8009 reports. */
export function isNever(warmup) {
    return warmup.kind === 'never';
}
//# sourceMappingURL=warmup.js.map