import { NONE, fold, held, hl2, hlc3, isPresent, result, tailOf } from '../values/index.js';
import { emaStep, smaStep } from '../averages/index.js';
import { changeStep, sumStep } from '../series/index.js';
import { moneyFlow } from './accumulation.js';
/** `cmf(len)`: accumulation over the lookback as a fraction of its volume, from bar `len - 1`. */
export function cmfStep(state, key, bar, len) {
    const flow = sumStep(state, `${key}f`, moneyFlow(bar), len);
    const traded = sumStep(state, `${key}v`, bar.volume, len);
    // A ratio is absent where its divisor is zero, and only there: a window whose
    // volume sums below zero divides like any other.
    if (!isPresent(flow) || !isPresent(traded) || traded === 0)
        return NONE;
    return result(flow / traded);
}
/** `cmf(len)` as a tail. */
export function cmfTail(len = 20) {
    return tailOf((state, bar) => cmfStep(state, '', bar, len));
}
/** `cmf(len)` over a run of bars. */
export function cmf(bars, len = 20) {
    return fold(cmfTail(len), bars);
}
/**
 * `mfi(len)`: the strength reading computed on money flow rather than price,
 * from bar `len`.
 *
 * A bar's whole flow counts on one side or the other, by whether the typical
 * price rose or fell, so the first lookback is bars 1 to `len` and the extra bar
 * is in the declared warmup.
 */
export function mfiStep(state, key, bar, len) {
    const typicalKey = `${key}p`;
    const seenKey = `${key}k`;
    const typical = hlc3(bar);
    const before = held(state, typicalKey);
    const started = state[seenKey] === true;
    state[seenKey] = true;
    state[typicalKey] = typical;
    let up = NONE;
    let down = NONE;
    if (started && isPresent(typical) && isPresent(before) && isPresent(bar.volume)) {
        const flow = result(typical * bar.volume);
        up = typical > before ? flow : 0;
        down = typical < before ? flow : 0;
    }
    const rise = sumStep(state, `${key}u`, up, len);
    const fall = sumStep(state, `${key}d`, down, len);
    if (!isPresent(rise) || !isPresent(fall))
        return NONE;
    // No down bar in the lookback is the top of the scale, as in `rsi`.
    if (fall === 0)
        return 100;
    return result(100 - 100 / (1 + rise / fall));
}
/** `mfi(len)` as a tail. */
export function mfiTail(len = 14) {
    return tailOf((state, bar) => mfiStep(state, '', bar, len));
}
/** `mfi(len)` over a run of bars. */
export function mfi(bars, len = 14) {
    return fold(mfiTail(len), bars);
}
/**
 * `eom(len)`: how far price moved per unit of volume, from bar `len`.
 *
 * The midpoint's move, times the bar's range, over the volume traded, then
 * averaged over the lookback. The midpoint move needs the previous bar, so the
 * average's lookback starts at bar 1 and the first reading is at bar `len`.
 *
 * **No scaling constant.** Implementations of this reading usually multiply by
 * a large divisor whose only job is to bring the number into a readable range,
 * and they do not agree on it. `stdlib.md` section 7 declares `eom(len = 14)`
 * with no such argument, so there is none here and the reading is the quantity
 * itself. That leaves it very small on a liquid instrument, which is recorded
 * as a gap in the specification rather than papered over with a constant this
 * library invented.
 */
export function eomStep(state, key, bar, len) {
    const travelled = changeStep(state, `${key}c`, hl2(bar), 1);
    let term = NONE;
    if (isPresent(travelled) &&
        isPresent(bar.high) &&
        isPresent(bar.low) &&
        isPresent(bar.volume) &&
        bar.volume !== 0) {
        term = result((travelled * (bar.high - bar.low)) / bar.volume);
    }
    return smaStep(state, `${key}q`, term, len);
}
/** `eom(len)` as a tail. */
export function eomTail(len = 14) {
    return tailOf((state, bar) => eomStep(state, '', bar, len));
}
/** `eom(len)` over a run of bars. */
export function eom(bars, len = 14) {
    return fold(eomTail(len), bars);
}
/** `forceIndex(len)`: change times volume, smoothed, from bar `len`. */
export function forceIndexStep(state, key, bar, len) {
    const moved = changeStep(state, `${key}c`, bar.close, 1);
    const force = isPresent(moved) && isPresent(bar.volume) ? result(moved * bar.volume) : NONE;
    return emaStep(state, `${key}e`, force, len);
}
/** `forceIndex(len)` as a tail. */
export function forceIndexTail(len = 13) {
    return tailOf((state, bar) => forceIndexStep(state, '', bar, len));
}
/** `forceIndex(len)` over a run of bars. */
export function forceIndex(bars, len = 13) {
    return fold(forceIndexTail(len), bars);
}
/** `relativeVolume(len)`: this bar's volume over its own recent average, from bar `len - 1`. */
export function relativeVolumeStep(state, key, volume, len) {
    const mean = smaStep(state, `${key}q`, volume, len);
    if (!isPresent(mean) || !isPresent(volume) || mean === 0)
        return NONE;
    return result(volume / mean);
}
/** `relativeVolume(len)` as a tail. */
export function relativeVolumeTail(len = 20) {
    return tailOf((state, bar) => relativeVolumeStep(state, '', bar.volume, len));
}
/** `relativeVolume(len)` over a run of bars. */
export function relativeVolume(bars, len = 20) {
    return fold(relativeVolumeTail(len), bars);
}
//# sourceMappingURL=flow.js.map