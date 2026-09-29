import { newState, slot } from './region.js';
import { ContributionHistory } from './history.js';
import { NONE, isLength, isPresent, result } from './value.js';
/**
 * A lookback of `len` bars, held in a region under `key`.
 *
 * A length outside its contract yields a lookback that never fills, so every
 * function built on it returns absence rather than a number computed from a
 * nonsense length. See `isLength` for why that is absence and not a diagnostic.
 */
export function ring(record, key, len) {
    const size = len !== null && isLength(len) ? len : 0;
    const bars = `${key}:h`;
    const maximumKey = `${key}:m`;
    const held = record[bars];
    let history = held instanceof ContributionHistory ? held : new ContributionHistory();
    const before = record[maximumKey];
    const maximum = Math.max(typeof before === 'number' ? before : 0, size);
    record[maximumKey] = maximum;
    let view = history.view(size);
    return lookback(size, (value) => {
        history = history.append(value);
        record[bars] = history;
        view = history.view(size);
    }, () => size > 0 && history.count >= maximum, (back) => view.at(back));
}
/** The arithmetic is shared so fixed-length accumulation keeps its exact order. */
function lookback(size, push, filled, at) {
    const lookback = {
        push, filled, at,
        presentCount() {
            let counted = 0;
            for (let back = size - 1; back >= 0; back -= 1) {
                if (isPresent(lookback.at(back)))
                    counted += 1;
            }
            return counted;
        },
        complete() {
            return lookback.filled() && lookback.presentCount() === size;
        },
        sum() {
            if (!lookback.complete())
                return NONE;
            let total = 0;
            // Oldest first: `back` counts down to the bar just pushed.
            for (let back = size - 1; back >= 0; back -= 1) {
                total += lookback.at(back);
            }
            return result(total);
        },
        sumPresent() {
            if (!lookback.filled())
                return NONE;
            let total = 0;
            for (let back = size - 1; back >= 0; back -= 1) {
                const value = lookback.at(back);
                if (isPresent(value))
                    total += value;
            }
            return result(total);
        },
        mean() {
            const total = lookback.sum();
            return isPresent(total) ? result(total / size) : NONE;
        },
    };
    return lookback;
}
/** A lookback of `len` bars in a region of its own, for a caller that has none. */
export function makeLookback(len) {
    return ring(newState(), 'q', len);
}
/**
 * Seeded smoothing: the mean of the first complete lookback, then one step per
 * bar.
 *
 * The seed lookback is complete only when it holds `len` present values, so an
 * average taken over another study's output starts counting at that study's
 * first value rather than at bar 0. That is what makes the warmups of
 * `stdlib.md` compose, and it is why `ema(sma(close, 10), 10)` is absent until
 * bar 18 rather than bar 9.
 *
 * A hole in the input freezes the recurrence: an absent bar after seeding
 * produces an absent bar out and leaves the running value untouched, so the
 * next present bar continues from where the last one left off. The alternatives
 * are worse: consuming absence as zero would drag the average toward nothing,
 * and re-seeding would let one missing bar restart a two hundred bar average.
 * Missing lengths also freeze it. Readiness tracks all contributions and the
 * largest observed length, independently from the running value. A valid step
 * still advances that value while a later, larger length hides its output.
 */
export function smoothed(record, key, len, value, step) {
    const countKey = `${key}:n`;
    const maximumKey = `${key}:m`;
    const historyKey = `${key}~:h`;
    const runningKey = `${key}:r`;
    const startedKey = `${key}:o`;
    const valid = len !== null && isLength(len);
    const count = slot(record, countKey, 0) + 1;
    const maximum = Math.max(slot(record, maximumKey, 0), valid ? len : 0);
    record[countKey] = count;
    record[maximumKey] = maximum;
    if (record[startedKey] !== true) {
        const held = record[historyKey];
        const before = held instanceof ContributionHistory ? held : new ContributionHistory();
        const history = before.append(value);
        record[historyKey] = history;
        if (!valid || count < maximum)
            return NONE;
        const view = history.view(len);
        let total = 0;
        for (let back = len - 1; back >= 0; back -= 1) {
            const next = view.at(back);
            if (!isPresent(next))
                return NONE;
            total += next;
        }
        const mean = result(total / len);
        if (!isPresent(mean))
            return NONE;
        record[startedKey] = true;
        record[runningKey] = mean;
        // Checkpoints retain their immutable version; this live state needs only scalars.
        delete record[historyKey];
        return result(mean);
    }
    if (!valid || !isPresent(value))
        return NONE;
    const previous = record[runningKey];
    if (typeof previous !== 'number')
        return NONE;
    const next = step(previous, value);
    record[runningKey] = next;
    return count >= maximum ? result(next) : NONE;
}
//# sourceMappingURL=lookback.js.map