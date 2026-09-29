import { NONE, flag, fold, held, isPresent, result, slot, tailOf } from '../values/index.js';
/** `psar(start, step, max)`. */
export function psarStep(state, key, bar, start, step, ceiling) {
    const seenKey = `${key}k`;
    const beforeHigh = held(state, `${key}h`);
    const beforeLow = held(state, `${key}l`);
    const beforeClose = held(state, `${key}c`);
    const started = state[seenKey] === true;
    state[seenKey] = true;
    state[`${key}h`] = bar.high;
    state[`${key}l`] = bar.low;
    state[`${key}c`] = bar.close;
    if (start === null || step === null || ceiling === null)
        return [NONE, NONE];
    if (!isPresent(bar.high) || !isPresent(bar.low) || !isPresent(bar.close)) {
        return [NONE, NONE];
    }
    const seededKey = `${key}s`;
    const longKey = `${key}g`;
    const extremeKey = `${key}e`;
    const stopKey = `${key}p`;
    const rateKey = `${key}a`;
    // Seeding waits for a pair of complete bars rather than for bar 1 by
    // number. On clean data that is bar 1, which is the declared warmup; on
    // data with a hole at the start it is the first bar the seed can honestly
    // be taken from, rather than a stop placed at whatever the state happened
    // to hold.
    if (!flag(state, seededKey)) {
        if (!started)
            return [NONE, NONE];
        if (!isPresent(beforeHigh) || !isPresent(beforeLow) || !isPresent(beforeClose)) {
            return [NONE, NONE];
        }
        const up = bar.close > beforeClose;
        const seed = up ? beforeLow : beforeHigh;
        state[longKey] = up;
        state[extremeKey] = up ? bar.high : bar.low;
        state[stopKey] = seed;
        state[rateKey] = start;
        state[seededKey] = true;
        return [result(seed), up ? -1 : 1];
    }
    let long = flag(state, longKey);
    let extreme = slot(state, extremeKey, 0);
    let acceleration = slot(state, rateKey, start);
    let stop = slot(state, stopKey, 0);
    stop = stop + acceleration * (extreme - stop);
    if (long) {
        if (stop > bar.low) {
            long = false;
            stop = extreme;
            extreme = bar.low;
            acceleration = start;
        }
    }
    else if (stop < bar.high) {
        long = true;
        stop = extreme;
        extreme = bar.high;
        acceleration = start;
    }
    if (long) {
        if (bar.high > extreme) {
            extreme = bar.high;
            acceleration = Math.min(acceleration + step, ceiling);
        }
    }
    else if (bar.low < extreme) {
        extreme = bar.low;
        acceleration = Math.min(acceleration + step, ceiling);
    }
    state[longKey] = long;
    state[extremeKey] = extreme;
    state[stopKey] = stop;
    state[rateKey] = acceleration;
    return [result(stop), long ? -1 : 1];
}
/** `psar(start, step, max)` as a tail. */
export function psarTail(start = 0.02, step = 0.02, ceiling = 0.2) {
    return tailOf((state, bar) => psarStep(state, '', bar, start, step, ceiling));
}
/** `psar(start, step, max)` over a run of bars. */
export function psar(bars, start = 0.02, step = 0.02, ceiling = 0.2) {
    return fold(psarTail(start, step, ceiling), bars);
}
//# sourceMappingURL=psar.js.map