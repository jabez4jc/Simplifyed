const NOTHING = { filled: false, triggered: false };
/**
 * One order against one bar.
 *
 * A bar missing any of the four prices decides nothing: an incomplete bar is
 * not evidence that a level was reached and it is not evidence that it was not.
 */
export function testResting(order, bar, policy) {
    const open = bar.open;
    const high = bar.high;
    const low = bar.low;
    if (open === null || high === null || low === null || bar.close === null)
        return NOTHING;
    if (order.type === 'limit')
        return limitAgainst(order, open, high, low, policy);
    const trigger = order.trigger;
    if (trigger === null)
        return NOTHING;
    const reached = order.side === 'buy' ? high >= trigger : low <= trigger;
    if (!reached)
        return NOTHING;
    if (order.type === 'stop') {
        const gapped = order.side === 'buy' ? open >= trigger : open <= trigger;
        const price = gapped && policy.stopFillsAtOpenOnGap ? open : trigger;
        return { filled: true, price, atOpen: gapped && policy.stopFillsAtOpenOnGap, slips: true };
    }
    // A stop limit that triggered is a limit for the rest of this bar. Where the
    // limit is not traded through it keeps resting, and the caller is told the
    // trigger was reached so that the order rests as a limit from here on.
    const asLimit = limitAgainst(order, open, high, low, policy);
    return asLimit.filled ? asLimit : { filled: false, triggered: true };
}
/**
 * A limit against one bar.
 *
 * `limitNeedsThrough` is the difference between a strict comparison and a loose
 * one, and it is the only knob in this file that changes a fill into no fill
 * rather than one price into another.
 */
function limitAgainst(order, open, high, low, policy) {
    const limit = order.limit;
    if (limit === null)
        return NOTHING;
    if (order.side === 'buy') {
        const traded = policy.limitNeedsThrough ? low < limit : low <= limit;
        if (!traded)
            return NOTHING;
        // The open already below the limit is the better price, and it is the first
        // price the bar had.
        const gapped = open < limit;
        return { filled: true, price: gapped ? open : limit, atOpen: gapped, slips: false };
    }
    const traded = policy.limitNeedsThrough ? high > limit : high >= limit;
    if (!traded)
        return NOTHING;
    const gapped = open > limit;
    return { filled: true, price: gapped ? open : limit, atOpen: gapped, slips: false };
}
//# sourceMappingURL=resting.js.map