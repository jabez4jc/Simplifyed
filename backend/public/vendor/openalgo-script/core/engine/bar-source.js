export function isColumns(bars) {
    return !Array.isArray(bars);
}
/** Either form, as the bar cycle and the fold read it. */
export function sourceOf(bars) {
    return isColumns(bars) ? columnSource(bars) : recordSource(bars);
}
export function recordSource(bars) {
    return { get length() { return bars.length; }, at: (index) => bars[index] };
}
function cell(column, index) {
    const value = column === undefined || index >= column.length ? null : column[index];
    return value === null || value === undefined || Number.isNaN(value) ? null : value;
}
export function columnSource(columns) {
    const length = columns.time.length;
    return {
        length,
        at(index) {
            if (index < 0 || index >= length)
                return undefined;
            return {
                time: cell(columns.time, index),
                open: cell(columns.open, index),
                high: cell(columns.high, index),
                low: cell(columns.low, index),
                close: cell(columns.close, index),
                volume: cell(columns.volume, index),
                oi: cell(columns.oi, index),
            };
        },
    };
}
/**
 * The bars a run has been handed: a whole history, then whatever arrives live.
 *
 * `run` replaces the history; `append` and `update` write one bar over it. A
 * bar written live is held as the record it arrived as, which is the only form
 * a live bar has.
 */
export class KnownBars {
    base = recordSource([]);
    live = [];
    get length() {
        return Math.max(this.base.length, this.live.length);
    }
    at(index) {
        return this.live[index] ?? this.base.at(index);
    }
    set(index, bar) {
        this.live[index] = bar;
    }
    reset(base) {
        this.base = base;
        this.live.length = 0;
    }
}
//# sourceMappingURL=bar-source.js.map