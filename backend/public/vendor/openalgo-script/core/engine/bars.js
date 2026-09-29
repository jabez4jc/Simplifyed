import { ABSENT, numberValue } from './values/index.js';
/** The bar fields 2.10 names, and nothing else. */
export const BAR_FIELDS = [
    'open',
    'high',
    'low',
    'close',
    'volume',
    'time',
    'hl2',
    'hlc3',
    'ohlc4',
    'hlcc4',
    'oi',
    'bar.index',
    'bar.count',
    'bar.isFirst',
    'bar.isLast',
    'bar.isConfirmed',
    'bar.isRealtime',
    'bar.isNew',
    'bar.updates',
];
export function isBarField(name) {
    return BAR_FIELDS.includes(name);
}
function present(value) {
    return typeof value === 'number';
}
/** One bar field's value, by the definitions of 2.10. */
export function barField(field, bar, facts) {
    const { open, high, low, close } = bar;
    switch (field) {
        case 'open':
            return open ?? ABSENT;
        case 'high':
            return high ?? ABSENT;
        case 'low':
            return low ?? ABSENT;
        case 'close':
            return close ?? ABSENT;
        case 'volume':
            return bar.volume ?? ABSENT;
        case 'oi':
            return bar.oi ?? ABSENT;
        case 'time':
            return bar.time ?? ABSENT;
        case 'hl2':
            return present(high) && present(low) ? numberValue((high + low) / 2) : ABSENT;
        case 'hlc3':
            return present(high) && present(low) && present(close)
                ? numberValue((high + low + close) / 3)
                : ABSENT;
        case 'ohlc4':
            return present(open) && present(high) && present(low) && present(close)
                ? numberValue((open + high + low + close) / 4)
                : ABSENT;
        case 'hlcc4':
            return present(high) && present(low) && present(close)
                ? numberValue((high + low + close + close) / 4)
                : ABSENT;
        case 'bar.index':
            return facts.index;
        case 'bar.count':
            return facts.count;
        case 'bar.isFirst':
            return facts.isFirst;
        case 'bar.isLast':
            return facts.isLast;
        case 'bar.isConfirmed':
            return facts.isConfirmed;
        case 'bar.isRealtime':
            return facts.isRealtime;
        case 'bar.isNew':
            return facts.isNew;
        case 'bar.updates':
            return facts.updates;
        default:
            return ABSENT;
    }
}
/**
 * The eight bar facts.
 *
 * `bar.index` is a position in the supplied data, not a universal address:
 * loading more history shifts every index, which is why a script that has to
 * remember a bar stores `time` instead.
 */
export function factsFor(index, supplied, state, isNew, updates, session) {
    return {
        index,
        count: index + 1,
        isFirst: index === 0,
        // True when this is the greatest index the host has supplied. A live chart
        // supplies bars one at a time, so its newest bar is always the last; a run
        // over a whole dataset supplies them together, so only its final bar is.
        isLast: index === supplied - 1,
        isConfirmed: state.isConfirmed ?? true,
        isRealtime: state.isRealtime ?? false,
        isNew,
        updates,
        isSessionFirst: session.isFirstBar,
        isSessionLast: session.isLastBar,
    };
}
/**
 * The bar as a library call sees it, `compiled-program.md` 2.10.
 *
 * The same numbers the registers above are filled from, in the shape a call
 * reads them in, so that a call and a register can never disagree about what
 * the bar was. `previousClose` is a fact about the dataset rather than about
 * any one call, which is why it travels here rather than in a state region.
 */
export function barViewOf(bar, facts, previousClose) {
    return {
        index: facts.index,
        open: bar.open ?? null,
        high: bar.high ?? null,
        low: bar.low ?? null,
        close: bar.close ?? null,
        volume: bar.volume ?? null,
        time: bar.time ?? null,
        previousClose: typeof previousClose === 'number' ? previousClose : null,
        isConfirmed: facts.isConfirmed,
        isRealtime: facts.isRealtime,
        isNew: facts.isNew,
        isLast: facts.isLast,
        updates: facts.updates,
        isSessionFirst: facts.isSessionFirst,
        isSessionLast: facts.isSessionLast,
    };
}
//# sourceMappingURL=bars.js.map