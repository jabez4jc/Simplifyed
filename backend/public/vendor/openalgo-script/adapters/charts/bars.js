/** Milliseconds in a second, so the conversion is named rather than a literal. */
export const MS = 1000;
export function hostBar(bar) {
    return {
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        time: Number.isFinite(bar.time) ? bar.time * MS : null,
        ...(bar.volume === undefined ? {} : { volume: bar.volume }),
        ...(bar.oi === undefined ? {} : { oi: bar.oi }),
    };
}
/** A chart's wall clock reading, in the units the engine's `chart.now()` uses. */
export function hostNow(seconds) {
    return seconds * MS;
}
/**
 * What the host states about one execution.
 *
 * Only the newest bar can be unconfirmed or driven by a live feed: every bar
 * before it is history, whatever the feed behind the chart is doing now. The
 * chart's own calculation context says which of those two the newest bar is,
 * and says nothing at all about the ones before it, which is the same split.
 */
export function stateFor(index, bars, ctx) {
    const last = index === bars.length - 1;
    const isConfirmed = !last || ctx === undefined ? true : ctx.barState.isConfirmed;
    const isRealtime = last && ctx !== undefined ? ctx.barState.isRealtime : false;
    return { isConfirmed, isRealtime };
}
//# sourceMappingURL=bars.js.map